"""Search by meaning (F-078): the download, the checks, and the loopback embedding engine.

No network: a loopback HTTP server stands in for GitHub and Hugging Face, and a small Python script stands in for
llama-server (it serves /health and /v1/embeddings and logs what it was asked, so the prompts can be checked).
"""

import hashlib
import io
import json
import math
import os
import sys
import tarfile
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

from starlette.testclient import TestClient

import search_runtime
from routes import create_app
from search_runtime import Pin, SearchError, SearchRuntime, document_prompt, query_prompt
from tests.test_voice import FakeSource

KEY = "linux-x86_64"

FAKE_SERVER = f"""#!{sys.executable}
import json, os, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
args = sys.argv[1:]
assert "--embedding" in args and args[args.index("--pooling") + 1] == "mean"
assert args[args.index("--host") + 1] == "127.0.0.1"
assert "--no-slots" in args and "--api-key" not in args, "the key goes in the environment, not on the command line"
key = os.environ["LLAMA_API_KEY"]
port = int(args[args.index("--port") + 1])
if os.environ.get("FAKE_ENGINE_MODE") == "crash":
    sys.exit(3)
log = os.environ.get("FAKE_LOG")

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass
    def send(self, body):
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def allowed(self):
        if self.headers.get("Authorization") == "Bearer " + key:
            return True
        self.send_error(401)
        return False
    def do_GET(self):
        if self.path == "/health":
            self.send({{"status": "ok"}})
        elif self.path == "/props" and self.allowed():
            self.send({{"model": "stub"}})
        else:
            self.send_error(404)
    def do_POST(self):
        if not self.allowed():
            return
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        if self.path == "/tokenize" and os.environ.get("FAKE_TOKENIZE") == "fail":
            self.send_error(500)
            return
        if self.path != "/tokenize" and os.environ.get("FAKE_ENGINE_MODE") == "hang":  # an engine that never answers an embedding
            import time
            time.sleep(120)
        if self.path == "/tokenize":  # one token per character, or one in all when FAKE_TOKENS=few (a tokenizer that undercounts)
            self.send({{"tokens": [0] if os.environ.get("FAKE_TOKENS") == "few" else [0] * len(body["content"])}})
            return
        asked = body["input"]
        too_long = [item for item in asked if len(item) > 2048]  # the real engine answers 500 for an input over its 2048 tokens
        if too_long:
            data = json.dumps({{"error": {{"code": 500, "message": "input (%d tokens) is too large to process. increase the physical batch size" % len(too_long[0]), "type": "server_error"}}}}).encode()
            self.send_response(500)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if log:
            with open(log, "a") as handle:
                handle.write(json.dumps(asked) + "\\n")
        # 768 numbers like the real model: [3, 4, 0 ...] then a 5 past the 256th place, so a cut to 256 and a
        # renormalise gives exactly [0.6, 0.8, 0 ...]; the items come back out of order to check the index is used.
        vector = [3.0, 4.0] + [0.0] * 766
        vector[500] = 5.0
        items = [{{"index": i, "embedding": vector}} for i in range(len(asked))]
        self.send({{"data": list(reversed(items))}})

ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
"""


def llama_archive(files: dict[str, bytes] | None = None, links: dict[str, str] | None = None, top: str = "llama-b11681", special: dict[str, tuple[bytes, str]] | None = None) -> bytes:
    if files is None:
        files = {"llama-server": FAKE_SERVER.encode(), "libggml.so.0.27.0": b"lib", "llama-cli": b"unused tool", "LICENSE": b"MIT"}
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        folder = tarfile.TarInfo(top)
        folder.type = tarfile.DIRTYPE
        folder.mode = 0o755
        archive.addfile(folder)
        for name, data in files.items():
            info = tarfile.TarInfo(name if name.startswith("..") or name.startswith("/") else f"{top}/{name}")
            info.size = len(data)
            info.mode = 0o755
            archive.addfile(info, io.BytesIO(data))
        for name, (kind, target) in (special or {}).items():  # hard links and device files
            info = tarfile.TarInfo(f"{top}/{name}")
            info.type = kind
            info.linkname = target
            archive.addfile(info)
        for name, target in (links or {}).items():
            info = tarfile.TarInfo(f"{top}/{name}")
            info.type = tarfile.SYMTYPE
            info.linkname = target
            archive.addfile(info)
    return buffer.getvalue()


class SearchTestCase(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "search"
        self.source = FakeSource()
        self.model = os.urandom(300_000)
        self.source.files["/model.gguf"] = self.model
        self.publish_engine(llama_archive())
        self.runtimes: list[SearchRuntime] = []

    def tearDown(self):
        for runtime in self.runtimes:
            runtime.shutdown()
        self.source.close()
        self.temporary.cleanup()

    def publish_engine(self, archive: bytes) -> bytes:
        self.engine_archive = archive
        self.source.files["/engine.tar.gz"] = archive
        return archive

    def runtime(self, **options) -> SearchRuntime:
        defaults = dict(
            root=self.root, key=KEY,
            engine=Pin(f"{self.source.base}/engine.tar.gz", len(self.engine_archive), hashlib.sha256(self.engine_archive).hexdigest()),
            model=Pin(f"{self.source.base}/model.gguf", len(self.model), hashlib.sha256(self.model).hexdigest()),
            ready_timeout=15,
        )
        runtime = SearchRuntime(**(defaults | options))
        self.runtimes.append(runtime)
        return runtime

    def install(self, runtime: SearchRuntime) -> dict:
        runtime.start_install()
        runtime.wait_for_install(30)
        return runtime.status()


class PlatformTests(unittest.TestCase):
    def test_this_system_is_offered_only_on_linux_x86_64_and_apple_silicon(self):
        self.assertEqual(search_runtime.platform_key("Linux", "x86_64"), "linux-x86_64")
        self.assertEqual(search_runtime.platform_key("Darwin", "arm64"), "macos-arm64")
        self.assertIsNone(search_runtime.platform_key("Windows", "AMD64"))

    def test_unsupported_system_says_so_and_refuses_to_install_or_embed(self):
        runtime = SearchRuntime(root=Path(tempfile.gettempdir()) / "never-created-search", key=None)
        self.assertEqual(runtime.status()["state"], "unsupported")
        with self.assertRaisesRegex(SearchError, "not available on this system"):
            runtime.start_install()
        with self.assertRaisesRegex(SearchError, "not available on this system"):
            runtime.embed(["x"], "query")

    def test_the_pins_name_both_engines_and_the_model(self):
        self.assertEqual(search_runtime.ENGINE_PINS["linux-x86_64"].sha256, "a3f47bfd4bc91181534e87bfa24161205fdef91adcd0a026d20e683241b2ba7d")
        self.assertEqual(search_runtime.ENGINE_PINS["macos-arm64"].sha256, "a98b30f90e2c01d34dcc6bf49d4cd20936a72735e3101aaa421424abeae42f3e")
        self.assertEqual(search_runtime.MODEL_PIN.bytes, 309855456)
        self.assertEqual(search_runtime.MODEL_PIN.sha256, "2188ac1deca4b77dffefd603c2776a9d76d9d74ec01841392982ebb840b09135")
        self.assertIn("bfcd298762cc34d0357ece5ebdd31791a3a374d8", search_runtime.MODEL_PIN.url)
        self.assertTrue(search_runtime.ENGINE_PINS["linux-x86_64"].url.startswith("https://github.com/ggml-org/llama.cpp/releases/download/b11681/"))

    def test_the_prompts_are_the_ones_the_model_was_trained_with(self):
        self.assertEqual(document_prompt("Sleep log", "slept badly"), "title: Sleep log | text: slept badly")
        self.assertEqual(document_prompt("", "slept badly"), "title: none | text: slept badly")
        self.assertEqual(query_prompt("why am I tired"), "task: search result | query: why am I tired")


class InstallTests(SearchTestCase):
    def test_not_installed_until_both_files_verify_then_ready_with_the_engine_in_place(self):
        runtime = self.runtime()
        self.assertEqual(runtime.status()["state"], "not-installed")

        status = self.install(runtime)

        self.assertEqual(status["state"], "ready")
        self.assertEqual(status["percent"], 100)
        self.assertTrue(os.access(runtime.binary_path, os.X_OK))
        self.assertEqual(sorted(p.name for p in runtime.engine_dir.iterdir() if not p.name.startswith(".")), ["LICENSE", "libggml.so.0.27.0", "llama-server"])
        self.assertEqual(runtime.model_path.read_bytes(), self.model)
        self.assertFalse(list(self.root.rglob("*.part")))
        marker = json.loads((self.root / "installed.json").read_text())
        self.assertEqual(marker["model"]["sha256"], hashlib.sha256(self.model).hexdigest())
        self.assertEqual(marker["platform"], KEY)

    def test_a_bad_engine_checksum_installs_nothing_and_the_download_is_discarded(self):
        runtime = self.runtime(engine=Pin(f"{self.source.base}/engine.tar.gz", len(self.engine_archive), "0" * 64))

        status = self.install(runtime)

        self.assertEqual(status["state"], "error")
        self.assertIn("checksum", status["error"])
        self.assertFalse((self.root / "installed.json").exists())
        self.assertFalse(runtime.binary_path.exists())
        self.assertFalse(list(self.root.rglob("*.part")) or list((self.root / "downloads").glob("*")))

    def test_a_server_that_sends_more_than_the_pinned_size_is_cut_off_and_nothing_is_kept(self):
        self.source.files["/model.gguf"] = self.model + os.urandom(2_000_000)
        runtime = self.runtime()

        status = self.install(runtime)

        self.assertEqual(status["state"], "error")
        self.assertIn("more than expected", status["error"])
        self.assertFalse(list(self.root.rglob("*.part")))
        self.assertFalse(runtime.model_path.exists())

    def test_a_wrong_sized_engine_is_rejected_before_anything_is_unpacked(self):
        runtime = self.runtime(engine=Pin(f"{self.source.base}/engine.tar.gz", len(self.engine_archive) + 5, hashlib.sha256(self.engine_archive).hexdigest()))
        status = self.install(runtime)
        self.assertEqual(status["state"], "error")
        self.assertFalse(runtime.binary_path.exists())

    def test_a_bad_model_checksum_writes_no_marker_and_removes_the_model(self):
        runtime = self.runtime(model=Pin(f"{self.source.base}/model.gguf", len(self.model), "f" * 64))

        status = self.install(runtime)

        self.assertEqual(status["state"], "error")
        self.assertIn("checksum", status["error"])
        self.assertFalse((self.root / "installed.json").exists())
        self.assertFalse(runtime.model_path.exists())

    def test_a_failure_keeps_the_verified_engine_so_the_retry_downloads_only_the_model(self):
        broken = self.runtime(model=Pin(f"{self.source.base}/model.gguf", len(self.model), "f" * 64))
        self.install(broken)
        self.source.requests.clear()

        status = self.install(self.runtime())

        self.assertEqual(status["state"], "ready")
        self.assertEqual([path for path, _ in self.source.requests], ["/model.gguf"])

    def test_a_partial_model_download_resumes_from_where_it_stopped(self):
        runtime = self.runtime()
        runtime.model_path.parent.mkdir(parents=True)
        (runtime.model_path.parent / (runtime.model_path.name + ".part")).write_bytes(self.model[:120_000])
        self.assertEqual(runtime.status()["partialBytes"], 120_000)

        status = self.install(runtime)

        self.assertEqual(status["state"], "ready")
        self.assertIn(("/model.gguf", "bytes=120000-"), self.source.requests)
        self.assertEqual(runtime.model_path.read_bytes(), self.model)

    def test_a_partial_file_longer_than_the_model_restarts_cleanly(self):
        runtime = self.runtime()
        runtime.model_path.parent.mkdir(parents=True)
        (runtime.model_path.parent / (runtime.model_path.name + ".part")).write_bytes(os.urandom(len(self.model) + 10))

        status = self.install(runtime)

        self.assertEqual(status["state"], "ready")
        self.assertEqual(runtime.model_path.read_bytes(), self.model)

    def test_a_corrupt_partial_file_fails_the_checksum_and_a_retry_starts_over(self):
        runtime = self.runtime()
        runtime.model_path.parent.mkdir(parents=True)
        (runtime.model_path.parent / (runtime.model_path.name + ".part")).write_bytes(b"x" * 1000)
        self.assertEqual(self.install(runtime)["state"], "error")
        self.assertFalse(list(self.root.rglob("*.part")))

        self.assertEqual(self.install(runtime)["state"], "ready")

    def test_cancel_keeps_the_partial_download_and_the_next_download_resumes(self):
        self.source.piece_delay = 0.3
        runtime = self.runtime()
        runtime.start_install()
        deadline = time.monotonic() + 10
        while runtime.status()["percent"] in (None, 0) and time.monotonic() < deadline:
            time.sleep(0.05)

        status = runtime.cancel_install()

        self.assertEqual(status["state"], "not-installed")
        self.assertGreater(status["partialBytes"], 0)
        self.assertFalse((self.root / "installed.json").exists())
        self.source.piece_delay = 0
        self.assertEqual(self.install(runtime)["state"], "ready")

    def test_a_server_that_is_down_is_reported_in_words(self):
        runtime = self.runtime(engine=Pin("http://127.0.0.1:9/engine.tar.gz", 10, "0" * 64))
        status = self.install(runtime)
        self.assertEqual(status["state"], "error")
        self.assertIn("Could not reach the download server", status["error"])

    def test_a_missing_file_is_reported_in_words(self):
        del self.source.files["/model.gguf"]
        status = self.install(self.runtime())
        self.assertEqual(status["state"], "error")
        self.assertIn("could not be found", status["error"])

    def test_a_second_install_while_one_runs_does_not_start_another(self):
        self.source.piece_delay = 0.02
        runtime = self.runtime()
        runtime.start_install()
        runtime.start_install()
        runtime.wait_for_install(30)
        self.assertEqual(runtime.status()["state"], "ready")
        self.assertEqual([p for p, _ in self.source.requests].count("/engine.tar.gz"), 1)

    def test_a_manifest_in_the_environment_replaces_the_pins_for_tests_and_mirrors(self):
        manifest = Path(self.temporary.name) / "manifest.json"
        manifest.write_text(json.dumps({
            "engine": {"url": f"{self.source.base}/engine.tar.gz", "bytes": len(self.engine_archive), "sha256": hashlib.sha256(self.engine_archive).hexdigest()},
            "model": {"url": f"{self.source.base}/model.gguf", "bytes": len(self.model), "sha256": hashlib.sha256(self.model).hexdigest()},
        }))
        with mock.patch.dict(os.environ, {"PERSONAL_NOTE_SEARCH_MANIFEST": str(manifest)}):
            runtime = SearchRuntime(root=self.root, key=KEY)
        self.runtimes.append(runtime)
        self.assertEqual(self.install(runtime)["state"], "ready")


class UnpackTests(SearchTestCase):
    def failed(self, archive: bytes, message: str):
        self.publish_engine(archive)
        runtime = self.runtime()
        status = self.install(runtime)
        self.assertEqual(status["state"], "error")
        self.assertIn(message, status["error"])
        self.assertFalse((self.root / "installed.json").exists())
        self.assertFalse(runtime.binary_path.exists())
        return runtime

    def test_a_path_that_climbs_out_of_the_folder_is_refused(self):
        self.failed(llama_archive({"llama-server": b"x", "../../escaped.txt": b"bad"}), "not safe to unpack")
        self.assertFalse((self.root.parent / "escaped.txt").exists())

    def test_a_link_pointing_outside_the_folder_is_refused(self):
        self.failed(llama_archive(links={"libevil.so": "/etc/passwd"}), "not safe to unpack")
        self.failed(llama_archive(links={"libevil.so": "../../outside"}), "not safe to unpack")

    def test_an_absolute_path_is_refused(self):
        self.failed(llama_archive({"llama-server": b"x", "/tmp/pn-f078-absolute.txt": b"bad"}), "not safe to unpack")
        self.assertFalse(Path("/tmp/pn-f078-absolute.txt").exists())

    def test_a_hard_link_is_refused(self):
        self.failed(llama_archive(special={"libhard.so": (tarfile.LNKTYPE, "llama-server")}), "not safe to unpack")

    def test_a_device_file_is_refused(self):
        self.failed(llama_archive(special={"libdevice.so": (tarfile.CHRTYPE, "")}), "not safe to unpack")

    def test_the_library_links_a_release_ships_are_kept_as_links_inside_the_folder(self):
        archive = llama_archive(links={"libggml.so.0": "libggml.so.0.27.0", "libggml.so": "libggml.so.0"})
        self.publish_engine(archive)
        runtime = self.runtime()

        self.assertEqual(self.install(runtime)["state"], "ready")

        self.assertEqual(os.readlink(runtime.engine_dir / "libggml.so"), "libggml.so.0")
        self.assertEqual((runtime.engine_dir / "libggml.so").read_bytes(), b"lib")

    def test_an_archive_without_the_server_is_refused(self):
        self.failed(llama_archive({"LICENSE": b"MIT"}), "does not contain")


class StatusTests(SearchTestCase):
    def test_files_that_went_missing_after_install_are_reported_as_damaged_not_as_never_installed(self):
        runtime = self.runtime()
        self.install(runtime)
        runtime.model_path.unlink()

        status = runtime.status()

        self.assertEqual(status["state"], "error")
        self.assertIn("damaged", status["error"])
        self.assertEqual(self.install(runtime)["state"], "ready")  # download again repairs it

    def test_a_model_of_the_wrong_size_is_damaged_too(self):
        runtime = self.runtime()
        self.install(runtime)
        runtime.model_path.write_bytes(b"short")
        self.assertEqual(runtime.status()["state"], "error")

    def test_the_label_says_how_big_the_download_is(self):
        self.assertEqual(self.runtime().status()["downloadLabel"], "about 315 MB")


class EngineTests(SearchTestCase):
    def ready(self, **options) -> SearchRuntime:
        runtime = self.runtime(**options)
        self.assertEqual(self.install(runtime)["state"], "ready")
        return runtime

    def asked(self) -> list:
        return [json.loads(line) for line in Path(self.log).read_text().splitlines()]

    def setUp(self):
        super().setUp()
        self.log = str(Path(self.temporary.name) / "asked.log")
        patch = mock.patch.dict(os.environ, {"FAKE_LOG": self.log})
        patch.start()
        self.addCleanup(patch.stop)

    def test_the_engine_does_not_run_until_something_is_embedded(self):
        runtime = self.ready()
        self.assertFalse(runtime.status()["running"])

        runtime.embed(["hello"], "query")

        self.assertTrue(runtime.status()["running"])

    def test_documents_and_queries_get_their_own_prompts_and_come_back_unit_length_at_256(self):
        runtime = self.ready()

        documents = runtime.embed([("Sleep log", "slept badly"), "no title here"], "document")
        query = runtime.embed(["why am I tired in the morning"], "query")

        self.assertEqual(self.asked(), [
            ["title: Sleep log | text: slept badly", "title: none | text: no title here"],
            ["task: search result | query: why am I tired in the morning"],
        ])
        self.assertEqual(len(documents), 2)
        for vector in documents + query:
            self.assertEqual(len(vector), 256)
            self.assertAlmostEqual(vector[0], 0.6)
            self.assertAlmostEqual(vector[1], 0.8)
            self.assertAlmostEqual(math.sqrt(sum(v * v for v in vector)), 1.0)

    def test_the_dimension_is_configurable(self):
        runtime = self.ready(dimension=768)
        vector = runtime.embed(["x"], "query")[0]
        self.assertEqual(len(vector), 768)
        self.assertAlmostEqual(math.sqrt(sum(v * v for v in vector)), 1.0)
        self.assertAlmostEqual(vector[500], 5 / math.sqrt(50))

    def test_embedding_with_nothing_installed_says_so_and_starts_nothing(self):
        runtime = self.runtime()
        with self.assertRaisesRegex(SearchError, "not installed"):
            runtime.embed(["x"], "query")
        self.assertFalse(runtime.status()["running"])

    def test_shutdown_stops_the_engine_process(self):
        runtime = self.ready()
        runtime.embed(["x"], "query")
        pid = json.loads((self.root / "engine.pid").read_text())["pid"]

        runtime.shutdown()

        self.assertFalse(runtime.status()["running"])
        deadline = time.monotonic() + 5
        while search_runtime.voice_runtime._alive(pid) and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertFalse(search_runtime.voice_runtime._alive(pid))
        self.assertFalse((self.root / "engine.pid").exists())

    def test_the_engine_is_started_again_on_the_next_use_after_a_stop(self):
        runtime = self.ready()
        runtime.embed(["x"], "query")
        runtime.stop_engine()
        self.assertEqual(len(runtime.embed(["y"], "query")), 1)

    def test_an_engine_that_will_not_start_is_reported_and_not_retried_at_once(self):
        runtime = self.ready()
        with mock.patch.dict(os.environ, {"FAKE_ENGINE_MODE": "crash"}):
            with self.assertRaisesRegex(SearchError, "stopped while starting"):
                runtime.embed(["x"], "query")
        status = runtime.status()
        self.assertFalse(status["running"])
        self.assertIn("stopped while starting", status["engineError"])
        started = time.monotonic()
        with self.assertRaisesRegex(SearchError, "stopped while starting"):
            runtime.embed(["x"], "query")
        self.assertLess(time.monotonic() - started, 1.0)  # refused from memory, nothing was spawned

    def test_an_engine_that_died_is_started_again_and_the_call_still_succeeds(self):
        runtime = self.ready()
        runtime.embed(["x"], "query")
        pid = json.loads((self.root / "engine.pid").read_text())["pid"]
        os.kill(pid, 9)
        deadline = time.monotonic() + 5
        while runtime.status()["running"] and time.monotonic() < deadline:
            time.sleep(0.05)

        self.assertEqual(len(runtime.embed(["y"], "query")), 1)

    def test_a_second_runtime_with_its_own_pid_file_starts_without_stopping_the_first_ones_engine(self):
        app = self.ready()
        app.embed(["x"], "query")
        app_pid = json.loads((self.root / "engine.pid").read_text())["pid"]
        command_line = self.runtime(pid_name="engine-cli.pid")  # the personal-note command line shares the folder with the running app

        self.assertEqual(len(command_line.embed(["y"], "query")), 1)

        self.assertTrue(search_runtime.voice_runtime._alive(app_pid))
        self.assertEqual(len(app.embed(["z"], "query")), 1)
        self.assertNotEqual(json.loads((self.root / "engine-cli.pid").read_text())["pid"], app_pid)

    def test_the_engine_needs_a_key_for_everything_but_health_and_the_key_is_not_on_the_command_line(self):
        runtime = self.ready()
        runtime.embed(["x"], "query")
        endpoint = runtime.status()["endpoint"]
        pid = json.loads((self.root / "engine.pid").read_text())["pid"]

        def code(path, data=None, key=None):
            request = urllib.request.Request(f"{endpoint}{path}", data=data, headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {key}"} if key else {})})
            try:
                with urllib.request.urlopen(request, timeout=3) as response:
                    return response.status
            except urllib.error.HTTPError as error:
                return error.code

        body = json.dumps({"input": ["x"]}).encode()
        self.assertEqual(code("/v1/embeddings", body), 401)
        self.assertEqual(code("/props"), 401)
        self.assertEqual(code("/v1/embeddings", body, key="wrong"), 401)
        self.assertEqual(code("/health"), 200)
        self.assertEqual(code("/props", key=runtime._api_key), 200)
        self.assertEqual(code("/v1/embeddings", body, key=runtime._api_key), 200)
        arguments = subprocess.run(["ps", "-ww", "-p", str(pid), "-o", "args="], capture_output=True, text=True).stdout
        self.assertNotIn(runtime._api_key, arguments)
        self.assertGreaterEqual(len(runtime._api_key), 32)

    def test_each_launch_gets_a_new_key(self):
        runtime = self.ready()
        runtime.embed(["x"], "query")
        first = runtime._api_key
        runtime.stop_engine()
        runtime.embed(["x"], "query")
        self.assertNotEqual(runtime._api_key, first)

    def test_the_engine_listens_on_loopback_only(self):
        runtime = self.ready()
        runtime.embed(["x"], "query")
        endpoint = runtime.status()["endpoint"]
        self.assertTrue(endpoint.startswith("http://127.0.0.1:"))
        with urllib.request.urlopen(f"{endpoint}/health", timeout=3) as response:
            self.assertEqual(json.load(response), {"status": "ok"})

    def test_an_over_long_document_is_cut_to_fit_the_engine_context_and_the_rest_still_embeds(self):
        runtime = self.ready()

        vectors = runtime.embed([("Long", "a" * 6000), ("Short", "tea")], "document")

        sent = self.asked()[0]
        self.assertEqual(len(vectors), 2)
        self.assertTrue(sent[0].startswith("title: Long | text: aaaa"))
        self.assertTrue(1900 <= len(sent[0]) <= 2000, len(sent[0]))  # the engine reads 2048 tokens: cut to just under, not to a fifth
        self.assertEqual(sent[1], "title: Short | text: tea")

    def test_an_over_long_query_is_cut_too(self):
        runtime = self.ready()
        runtime.embed(["q" * 5000], "query")
        self.assertLessEqual(len(self.asked()[0][0]), 2000)

    def test_dense_text_that_the_engine_counts_one_token_per_character_never_reaches_it_over_budget(self):
        runtime = self.ready()
        runtime.embed([("CJK", "漢" * 6000), ("Emoji", "😀" * 6000)], "document")
        self.assertTrue(all(len(prompt) <= 2000 for prompt in self.asked()[0]))

    def test_an_engine_that_refuses_an_input_is_told_apart_from_one_that_is_down(self):
        runtime = self.ready()
        with mock.patch.dict(os.environ, {"FAKE_TOKENS": "few"}):  # a tokenizer that undercounts lets an over-long input through
            runtime.stop_engine()
            with self.assertRaises(search_runtime.SearchInputError) as raised:
                runtime.embed([("Long", "a" * 6000)], "document")
        self.assertIn("too long", str(raised.exception))
        runtime.stop_engine()
        with mock.patch.object(runtime, "_ensure_started", return_value=1):  # nothing listens on port 1
            with self.assertRaises(SearchError) as down:
                runtime.embed(["x"], "query")
        self.assertNotIsInstance(down.exception, search_runtime.SearchInputError)

    def test_the_engine_gets_a_limited_number_of_threads_so_typing_keeps_the_machine(self):
        for cores, expected in ((16, 4), (8, 4), (4, 2), (2, 1), (1, 1), (None, 1)):
            with mock.patch("os.cpu_count", return_value=cores):
                command = SearchRuntime(root=self.root, key=KEY)._command(1234)
            self.assertEqual(command[command.index("-t") + 1], str(expected), f"{cores} cores")
        self.assertEqual(SearchRuntime(root=self.root, key=KEY, threads=3)._command(1)[SearchRuntime(root=self.root, key=KEY, threads=3)._command(1).index("-t") + 1], "3")

    def test_shutdown_is_final_and_a_start_racing_it_never_leaves_an_engine(self):
        runtime = self.ready()
        real_choose = runtime._choose_port

        def shut_down_while_starting():
            runtime.shutdown()  # the app is closing while a background embed is just starting the engine
            return real_choose()

        with mock.patch.object(runtime, "_choose_port", shut_down_while_starting):
            with self.assertRaisesRegex(SearchError, "closing"):
                runtime.embed(["x"], "query")
        self.assertFalse(runtime.status()["running"])
        self.assertFalse((self.root / "engine.pid").exists())
        with self.assertRaisesRegex(SearchError, "closing"):
            runtime.embed(["y"], "query")
        self.assertFalse(runtime.status()["running"])

    def test_a_racing_start_that_gets_past_the_check_is_stopped_as_soon_as_it_registers(self):
        runtime = self.ready()
        real_ready = runtime._await_ready

        def shut_down_before_ready(process, port):
            runtime.shutdown()
            real_ready(process, port)

        with mock.patch.object(runtime, "_await_ready", shut_down_before_ready):
            with self.assertRaises(SearchError):
                runtime.embed(["x"], "query")
        self.assertFalse(runtime.status()["running"])

    def test_an_engine_nobody_has_used_for_the_idle_time_is_stopped_and_starts_again_on_the_next_use(self):
        now = [1000.0]
        runtime = self.ready(clock=lambda: now[0])
        runtime.embed(["x"], "query")
        pid = json.loads((self.root / "engine.pid").read_text())["pid"]

        now[0] += 299
        self.assertFalse(runtime.stop_if_idle(300))
        self.assertTrue(runtime.status()["running"])
        now[0] += 2
        self.assertTrue(runtime.stop_if_idle(300))

        self.assertFalse(runtime.status()["running"])
        deadline = time.monotonic() + 5
        while search_runtime.voice_runtime._alive(pid) and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertFalse(search_runtime.voice_runtime._alive(pid))
        self.assertFalse(runtime.stop_if_idle(300), "nothing running: nothing to stop")
        self.assertEqual(len(runtime.embed(["y"], "query")), 1)
        self.assertTrue(runtime.status()["running"])

    def test_using_the_engine_keeps_it_from_idling(self):
        now = [1000.0]
        runtime = self.ready(clock=lambda: now[0])
        runtime.embed(["x"], "query")
        now[0] += 250
        runtime.embed(["y"], "query")
        now[0] += 250
        self.assertFalse(runtime.stop_if_idle(300))
        self.assertTrue(runtime.status()["running"])

    def test_when_the_engine_cannot_count_tokens_a_prompt_is_cut_by_bytes_and_keeps_its_prefix(self):
        runtime = self.ready()
        with mock.patch.dict(os.environ, {"FAKE_TOKENIZE": "fail"}):
            runtime.stop_engine()
            for filler in ("a", "漢", "😀"):
                Path(self.log).write_text("")
                runtime.embed([("Long", filler * 6000)], "document")
                runtime.embed([filler * 6000], "query")
                documents, queries = (self.asked()[0][0], self.asked()[1][0])
                self.assertTrue(documents.startswith("title: Long | text: "), filler)
                self.assertTrue(queries.startswith("task: search result | query: "), filler)
                self.assertLessEqual(len(documents.encode()), 1800, filler)
                self.assertLessEqual(len(queries.encode()), 1800, filler)
                self.assertGreater(len(documents.encode()), 1700, "cut to the budget, not to nothing")

    def test_the_engine_runs_at_low_priority_so_typing_keeps_the_machine(self):
        runtime = self.ready()
        runtime.embed(["x"], "query")
        pid = json.loads((self.root / "engine.pid").read_text())["pid"]
        self.assertGreaterEqual(os.getpriority(os.PRIO_PROCESS, pid), 10)

    def test_on_a_mac_the_engine_is_started_as_a_background_task_when_taskpolicy_exists(self):
        runtime = SearchRuntime(root=self.root, key="macos-arm64")
        with mock.patch("shutil.which", return_value="/usr/sbin/taskpolicy"):
            self.assertEqual(runtime._launch_prefix()[:2], ["/usr/sbin/taskpolicy", "-b"])
        with mock.patch("shutil.which", return_value=None):
            self.assertEqual(runtime._launch_prefix(), [])
        self.assertEqual(SearchRuntime(root=self.root, key=KEY)._launch_prefix(), [])

    def test_closing_the_app_is_quick_even_when_the_engine_never_answers(self):
        from routes import close_search
        from meaning_index import MeaningIndexer
        from services import NoteService
        runtime = self.ready()
        service = NoteService(Path(self.temporary.name) / "n.db", embedder=runtime)
        note = service.create_note({"title": "Trip", "noteType": "page"})
        service.update_note(note["id"], {"title": "Trip", "content": {"markdown": "flights", "ink": {}}, "revision": 1})
        indexer = MeaningIndexer(service, runtime, idle=0, poll=0.05)
        with mock.patch.dict(os.environ, {"FAKE_ENGINE_MODE": "hang"}):
            indexer.start()
            deadline = time.monotonic() + 15
            while not runtime.status()["running"] and time.monotonic() < deadline:
                time.sleep(0.05)
            time.sleep(0.5)  # the batch is now waiting on the engine
            started = time.monotonic()
            close_search(type("App", (), {"state": type("State", (), {"search": runtime, "indexer": indexer})()})())
            took = time.monotonic() - started
        self.assertLess(took, 3.0)
        self.assertFalse(indexer._thread.is_alive())
        self.assertFalse(runtime.status()["running"])


class StopsWithTheAppTests(SearchTestCase):
    """The app's two exits: main.py's atexit hook and a process that is killed outright."""

    def ready(self) -> SearchRuntime:
        runtime = self.runtime()
        self.assertEqual(self.install(runtime)["state"], "ready")
        return runtime

    def app_process(self, then: str) -> subprocess.Popen:
        runtime = self.ready()
        manifest = Path(self.temporary.name) / "manifest.json"
        manifest.write_text(json.dumps({"engine": self.pin_dict(runtime.engine), "model": self.pin_dict(runtime.model)}))
        env = dict(os.environ, PERSONAL_NOTE_DB=str(Path(self.temporary.name) / "app.db"), PERSONAL_NOTE_SEARCH_DIR=str(self.root), PERSONAL_NOTE_SEARCH_MANIFEST=str(manifest), PERSONAL_NOTE_VOICE_DIR=str(Path(self.temporary.name) / "voice"))
        code = f"import main; main.app.state.search.embed(['x'], 'query'); print(open(r'{self.root / 'engine.pid'}').read(), flush=True); {then}"
        return subprocess.Popen([sys.executable, "-c", code], cwd=Path(__file__).resolve().parents[1], env=env, stdout=subprocess.PIPE, text=True)

    @staticmethod
    def pin_dict(pin: Pin) -> dict:
        return {"url": pin.url, "bytes": pin.bytes, "sha256": pin.sha256}

    def gone(self, pid: int) -> bool:
        deadline = time.monotonic() + 8
        while search_runtime.voice_runtime._alive(pid) and time.monotonic() < deadline:
            time.sleep(0.05)
        return not search_runtime.voice_runtime._alive(pid)

    def test_a_normal_exit_stops_the_engine_and_removes_its_pid_file(self):
        app = self.app_process("pass")
        pid = json.loads(app.stdout.readline())["pid"]
        self.assertEqual(app.wait(30), 0)
        self.assertTrue(self.gone(pid))
        self.assertFalse((self.root / "engine.pid").exists())

    @unittest.skipUnless(search_runtime.voice_runtime._PRCTL, "the kernel stops a child with its parent on Linux only")
    def test_an_app_that_is_killed_outright_takes_the_engine_with_it(self):
        app = self.app_process("import time; time.sleep(60)")
        pid = json.loads(app.stdout.readline())["pid"]
        self.assertTrue(search_runtime.voice_runtime._alive(pid))
        app.kill()
        app.wait(10)
        self.assertTrue(self.gone(pid))


class RoutesTests(SearchTestCase):
    def client(self, runtime: SearchRuntime) -> TestClient:
        app = create_app(Path(self.temporary.name) / "notes.db", search=runtime)
        self.addCleanup(app.state.note_service.close) if hasattr(app.state.note_service, "close") else None
        return TestClient(app)

    def test_status_is_readable_by_the_page_and_a_download_runs_to_ready(self):
        runtime = self.runtime()
        client = self.client(runtime)
        self.assertEqual(client.get("/api/search-meaning/status").json()["state"], "not-installed")

        response = client.post("/api/search-meaning/install", headers={"X-Personal-Note": "1"})
        runtime.wait_for_install(30)

        self.assertEqual(response.status_code, 202)
        self.assertEqual(client.get("/api/search-meaning/status").json()["state"], "ready")

    def test_a_page_from_another_site_cannot_start_or_cancel_a_download(self):
        client = self.client(self.runtime())
        self.assertEqual(client.post("/api/search-meaning/install").status_code, 403)
        self.assertEqual(client.post("/api/search-meaning/cancel").status_code, 403)
        self.assertEqual(client.get("/api/search-meaning/status").json()["state"], "not-installed")

    def test_cancel_through_the_api_keeps_the_partial_download(self):
        self.source.piece_delay = 0.3
        runtime = self.runtime()
        client = self.client(runtime)
        client.post("/api/search-meaning/install", headers={"X-Personal-Note": "1"})
        time.sleep(0.4)

        body = client.post("/api/search-meaning/cancel", headers={"X-Personal-Note": "1"}).json()

        self.assertEqual(body["state"], "not-installed")
        self.assertGreater(body["partialBytes"], 0)

    def test_an_unsupported_system_answers_with_a_message(self):
        client = self.client(SearchRuntime(root=Path(self.temporary.name) / "s", key=None))
        self.assertEqual(client.get("/api/search-meaning/status").json()["state"], "unsupported")
        response = client.post("/api/search-meaning/install", headers={"X-Personal-Note": "1"})
        self.assertEqual(response.status_code, 409)
        self.assertIn("not available on this system", response.json()["error"])

    def test_opening_the_app_never_starts_the_engine(self):
        runtime = self.runtime()
        self.install(runtime)
        client = self.client(runtime)
        self.assertEqual(client.get("/api/notebooks").status_code, 200)
        self.assertFalse(client.get("/api/search-meaning/status").json()["running"])


if __name__ == "__main__":
    unittest.main()
