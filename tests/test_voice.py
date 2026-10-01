import hashlib
import io
import json
import os
import signal
import socket
import stat
import sys
import tarfile
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from unittest import mock

from starlette.testclient import TestClient

import voice_runtime
from routes import create_app
from voice_runtime import MODEL_FILE, VoiceError, VoiceRuntime, engine_asset, engine_base_urls, platform_key

KEY = "linux-x86_64"
FAKE_ENGINE = f"""#!{sys.executable}
import socket, sys, time
import os, signal
args = sys.argv[1:]
port = int(args[args.index("--port") + 1])
if os.environ.get("FAKE_ENGINE_MODE") == "sigill":
    import resource
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    os.kill(os.getpid(), signal.SIGILL)
time.sleep(float(os.environ.get("FAKE_ENGINE_DELAY", "0")))
assert args[0] == "serve" and "--asr-model" in args and "--no-ui" in args and args[args.index("--host") + 1] == "127.0.0.1"
listener = socket.socket()
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(("127.0.0.1", port))
listener.listen()
while True:
    connection, _ = listener.accept()
    connection.close()
"""


def engine_archive(files: dict[str, bytes] | None = None, symlink: tuple[str, str] | None = None) -> bytes:
    files = {"bin/nemo-speech": FAKE_ENGINE.encode(), "engine.json": b"{}"} if files is None else files
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = 0o644
            archive.addfile(info, io.BytesIO(data))
        if symlink:
            info = tarfile.TarInfo(symlink[0])
            info.type = tarfile.SYMTYPE
            info.linkname = symlink[1]
            archive.addfile(info)
    return buffer.getvalue()


class FakeSource:
    """A loopback HTTP server standing in for the GitHub release and Hugging Face, with Range support."""

    def __init__(self):
        self.files: dict[str, bytes] = {}
        self.requests: list[tuple[str, str | None]] = []
        self.piece_delay = 0.0
        source = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                source.requests.append((self.path, self.headers.get("Range")))
                data = source.files.get(self.path)
                if data is None:
                    self.send_error(404)
                    return
                start = 0
                status = 200
                header = self.headers.get("Range")
                if header and header.startswith("bytes="):
                    start = int(header[6:].split("-")[0])
                    if start >= len(data):
                        self.send_error(416)
                        return
                    status = 206
                body = data[start:]
                self.send_response(status)
                self.send_header("Content-Length", str(len(body)))
                if status == 206:
                    self.send_header("Content-Range", f"bytes {start}-{len(data) - 1}/{len(data)}")
                self.end_headers()
                try:
                    for offset in range(0, len(body), 100_000):
                        self.wfile.write(body[offset:offset + 100_000])
                        self.wfile.flush()
                        if source.piece_delay:
                            time.sleep(source.piece_delay)
                except OSError:
                    pass  # the app cancelled the download

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def base(self) -> str:
        return f"http://127.0.0.1:{self.server.server_address[1]}"

    def publish_engine(self, archive: bytes, checksum: str | None = None, folder: str = "release") -> None:
        name = engine_asset(KEY)
        self.files[f"/{folder}/{name}"] = archive
        self.files[f"/{folder}/{name}.sha256"] = f"{checksum or hashlib.sha256(archive).hexdigest()}  {name}\n".encode()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class VoiceTestCase(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "voice"
        self.source = FakeSource()
        self.model = os.urandom(300_000)
        self.source.files["/model.gguf"] = self.model
        self.runtimes: list[VoiceRuntime] = []

    def tearDown(self):
        for runtime in self.runtimes:
            runtime.shutdown()
        self.source.close()
        self.temporary.cleanup()

    def runtime(self, **options) -> VoiceRuntime:
        defaults = dict(
            root=self.root, key=KEY, engine_url=f"{self.source.base}/release",
            model_url=f"{self.source.base}/model.gguf", model_bytes=len(self.model),
            model_sha256=hashlib.sha256(self.model).hexdigest(), ready_timeout=15,
        )
        runtime = VoiceRuntime(**(defaults | options))
        self.runtimes.append(runtime)
        return runtime

    def install(self, runtime: VoiceRuntime) -> dict:
        runtime.start_install()
        runtime.wait_for_install(30)
        return runtime.status()


class PlatformTests(unittest.TestCase):
    def test_voice_is_offered_for_linux_x86_64_and_apple_silicon_only(self):
        self.assertEqual(platform_key("Linux", "x86_64"), "linux-x86_64")
        self.assertEqual(platform_key("Linux", "AMD64"), "linux-x86_64")
        self.assertEqual(platform_key("Darwin", "arm64"), "macos-arm64")
        self.assertIsNone(platform_key("Darwin", "x86_64"))
        self.assertIsNone(platform_key("Linux", "aarch64"))
        self.assertIsNone(platform_key("Windows", "AMD64"))

    def test_engine_comes_from_the_matching_release_then_the_latest_one(self):
        self.assertEqual(engine_base_urls("1.2.3")[0], f"{voice_runtime.RELEASES_URL}/download/v1.2.3")
        self.assertEqual(engine_base_urls("1.2.3")[-1], f"{voice_runtime.RELEASES_URL}/latest/download")
        self.assertEqual(engine_base_urls(None), [f"{voice_runtime.RELEASES_URL}/latest/download"])
        self.assertEqual(engine_base_urls("1.2.3", "http://mirror/x/"), ["http://mirror/x"])

    def test_unsupported_system_reports_so_and_refuses_to_install(self):
        runtime = VoiceRuntime(root=Path(tempfile.gettempdir()) / "never-created-voice", key=None)
        self.assertEqual(runtime.status()["state"], "unsupported")
        with self.assertRaises(VoiceError):
            runtime.start_install()


class InstallTests(VoiceTestCase):
    def test_not_installed_until_a_download_finishes_then_ready_with_files_in_place(self):
        runtime = self.runtime()
        self.assertEqual(runtime.status()["state"], "not-installed")
        self.source.publish_engine(engine_archive())

        status = self.install(runtime)

        self.assertEqual(status["state"], "ready")
        self.assertEqual(status["percent"], 100)
        self.assertTrue(runtime.binary_path().is_file())
        self.assertTrue(os.access(runtime.binary_path(), os.X_OK))
        self.assertEqual((self.root / "models" / MODEL_FILE).read_bytes(), self.model)
        self.assertFalse(list(self.root.rglob("*.part")), "no partial files are left behind")

    def test_a_bad_engine_checksum_installs_nothing(self):
        self.source.publish_engine(engine_archive(), checksum="0" * 64)
        runtime = self.runtime()

        status = self.install(runtime)

        self.assertEqual(status["state"], "error")
        self.assertIn("checksum", status["error"])
        self.assertFalse(runtime.engine_dir.exists())
        self.assertFalse(runtime.installed())

    def test_a_corrupt_model_is_rejected_and_deleted(self):
        self.source.publish_engine(engine_archive())
        runtime = self.runtime(model_sha256="f" * 64)

        status = self.install(runtime)

        self.assertEqual(status["state"], "error")
        self.assertIn("checksum", status["error"])
        self.assertFalse((self.root / "models" / MODEL_FILE).exists())
        self.assertFalse(runtime.installed())

    def test_a_missing_engine_for_this_version_says_so_and_tries_the_latest_release(self):
        self.source.publish_engine(engine_archive(), folder="latest")
        runtime = self.runtime(engine_url=None, version="9.9.9")
        runtime.__dict__["_engine_candidates"] = lambda: [f"{self.source.base}/versioned", f"{self.source.base}/latest"]

        self.assertEqual(self.install(runtime)["state"], "ready")
        self.assertTrue(any(path.startswith("/versioned/") for path, _ in self.source.requests))

        other = VoiceRuntime(root=self.root / "none", key=KEY, engine_url=f"{self.source.base}/empty")
        status = self.install(other)
        self.assertEqual(status["state"], "error")
        self.assertIn("no voice engine", status["error"])

    def test_an_unreachable_server_is_a_readable_error(self):
        runtime = self.runtime(engine_url="http://127.0.0.1:1/none")

        status = self.install(runtime)

        self.assertEqual(status["state"], "error")
        self.assertIn("connection", status["error"])

    def test_the_download_resumes_from_the_partial_file(self):
        self.source.publish_engine(engine_archive())
        runtime = self.runtime()
        part = self.root / "models" / (MODEL_FILE + ".part")
        part.parent.mkdir(parents=True)
        part.write_bytes(self.model[:120_000])
        self.assertEqual(runtime.status()["partialBytes"], 120_000)

        self.assertEqual(self.install(runtime)["state"], "ready")

        ranges = [header for path, header in self.source.requests if path == "/model.gguf"]
        self.assertEqual(ranges, ["bytes=120000-"])
        self.assertEqual((self.root / "models" / MODEL_FILE).read_bytes(), self.model)

    def test_a_partial_file_longer_than_the_model_is_discarded_and_the_download_starts_again(self):
        self.source.publish_engine(engine_archive())
        runtime = self.runtime()
        part = self.root / "models" / (MODEL_FILE + ".part")
        part.parent.mkdir(parents=True)
        part.write_bytes(self.model + b"extra")

        self.assertEqual(self.install(runtime)["state"], "ready")
        self.assertEqual((self.root / "models" / MODEL_FILE).read_bytes(), self.model)

    def test_an_unsafe_archive_is_refused(self):
        self.source.publish_engine(engine_archive({"../escape.txt": b"x", "bin/nemo-speech": b"x"}))
        runtime = self.runtime()

        status = self.install(runtime)

        self.assertEqual(status["state"], "error")
        self.assertFalse((self.root.parent / "escape.txt").exists())

    def test_archive_links_are_refused_even_when_they_point_inside(self):
        for target in ("/etc/passwd", "nemo-speech"):
            self.source.publish_engine(engine_archive(symlink=("bin/lib.so.0", target)))
            self.assertEqual(self.install(self.runtime(root=self.root.parent / f"v-{len(target)}"))["state"], "error")

    def test_the_engine_build_that_was_downloaded_is_recorded_and_a_different_one_is_noted(self):
        self.source.publish_engine(engine_archive({"bin/nemo-speech": FAKE_ENGINE.encode(), "engine.json": b'{"commit": "abcdef1234567890"}'}))
        runtime = self.runtime()

        status = self.install(runtime)

        self.assertEqual(status["state"], "ready")
        self.assertEqual(json.loads(runtime.marker_path.read_text())["engine"]["commit"], "abcdef1234567890")
        self.assertIn("abcdef12", status["note"])

        same = self.runtime(root=self.root.parent / "same")
        self.source.publish_engine(engine_archive({"bin/nemo-speech": FAKE_ENGINE.encode(), "engine.json": json.dumps({"commit": voice_runtime.ENGINE_COMMIT}).encode()}))
        self.assertEqual(self.install(same)["note"], "")

    def test_a_finished_model_from_an_earlier_install_is_verified_not_downloaded_again(self):
        self.source.publish_engine(engine_archive())
        (self.root / "models").mkdir(parents=True)
        (self.root / "models" / MODEL_FILE).write_bytes(self.model)

        self.assertEqual(self.install(self.runtime())["state"], "ready")
        self.assertNotIn("/model.gguf", [path for path, _ in self.source.requests])

    def test_a_full_size_model_that_fails_its_checksum_is_replaced(self):
        self.source.publish_engine(engine_archive())
        (self.root / "models").mkdir(parents=True)
        (self.root / "models" / MODEL_FILE).write_bytes(b"x" * len(self.model))

        self.assertEqual(self.install(self.runtime())["state"], "ready")
        self.assertEqual((self.root / "models" / MODEL_FILE).read_bytes(), self.model)

    def test_cancel_stops_the_download_keeps_the_partial_file_and_pressing_download_resumes(self):
        self.model = os.urandom(3_000_000)
        self.source.files["/model.gguf"] = self.model
        self.source.piece_delay = 0.05
        self.source.publish_engine(engine_archive())
        runtime = self.runtime(model_bytes=len(self.model), model_sha256=hashlib.sha256(self.model).hexdigest())
        runtime.start_install()
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline and not (runtime._progress.phase == "model" and runtime._progress.current > 0):
            time.sleep(0.01)

        status = runtime.cancel_install()

        self.assertEqual(status["state"], "not-installed")
        self.assertGreater(status["partialBytes"], 0)
        self.assertTrue((self.root / "models" / (MODEL_FILE + ".part")).exists())
        self.assertFalse(runtime.installed())
        self.source.piece_delay = 0
        self.assertEqual(self.install(runtime)["state"], "ready")
        ranges = [header for path, header in self.source.requests if path == "/model.gguf" and header]
        self.assertTrue(ranges and ranges[0].startswith("bytes="), "resumed with a range request")
        self.assertEqual((self.root / "models" / MODEL_FILE).read_bytes(), self.model)

    def test_a_settings_file_may_only_name_an_https_engine_folder(self):
        runtime = self.runtime(engine_url=None)
        self.root.mkdir(parents=True)
        with mock.patch.dict(os.environ):
            os.environ.pop(voice_runtime.ENV_ENGINE_URL, None)
            (self.root / "settings.json").write_text(json.dumps({"engineBaseUrl": "http://mirror.example/x"}))
            self.assertNotIn("http://mirror.example/x", runtime._engine_candidates())
            (self.root / "settings.json").write_text(json.dumps({"engineBaseUrl": "https://mirror.example/x"}))
            self.assertEqual(runtime._engine_candidates(), ["https://mirror.example/x"])

    def test_an_archive_without_the_engine_is_refused(self):
        self.source.publish_engine(engine_archive({"readme.txt": b"hi"}))
        status = self.install(self.runtime())
        self.assertEqual(status["state"], "error")
        self.assertIn("does not contain the engine", status["error"])

    def test_remove_deletes_every_voice_file_and_stops_the_engine(self):
        self.source.publish_engine(engine_archive())
        runtime = self.runtime()
        self.install(runtime)
        runtime.start_engine()
        process = runtime._process

        status = runtime.remove()

        self.assertEqual(status["state"], "not-installed")
        self.assertFalse(self.root.exists())
        self.assertIsNotNone(process.poll())

    def test_installing_when_already_ready_changes_nothing(self):
        self.source.publish_engine(engine_archive())
        runtime = self.runtime()
        self.install(runtime)
        requests = len(self.source.requests)

        self.assertEqual(runtime.start_install()["state"], "ready")
        self.assertEqual(len(self.source.requests), requests)


class EngineProcessTests(VoiceTestCase):
    def installed(self, **options) -> VoiceRuntime:
        self.source.publish_engine(engine_archive())
        runtime = self.runtime(**options)
        self.assertEqual(self.install(runtime)["state"], "ready")
        return runtime

    def test_start_runs_the_engine_on_loopback_and_stop_ends_it(self):
        runtime = self.installed()
        status = runtime.start_engine()

        self.assertTrue(status["running"])
        port = int(status["endpoint"].rsplit(":", 1)[1].split("/")[0])
        self.assertTrue(status["endpoint"].startswith("ws://127.0.0.1:") and status["endpoint"].endswith("/v1/realtime"))
        socket.create_connection(("127.0.0.1", port), timeout=2).close()
        process = runtime._process

        runtime.stop_engine()

        self.assertIsNotNone(process.poll())
        self.assertFalse(runtime.status()["running"])
        self.assertIsNone(runtime.status()["endpoint"])
        self.assertTrue((self.root / "logs").is_dir())

    def test_the_preferred_port_is_used_when_free_and_another_when_taken(self):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            free = probe.getsockname()[1]
        runtime = self.installed(preferred_port=free)
        self.assertTrue(runtime.start_engine()["endpoint"].startswith(f"ws://127.0.0.1:{free}/"))
        runtime.stop_engine()

        with socket.socket() as busy:
            busy.bind(("127.0.0.1", 0))
            busy.listen()
            taken = busy.getsockname()[1]
            other = self.installed(preferred_port=taken, root=self.root.parent / "voice2")
            endpoint = other.start_engine()["endpoint"]
            self.assertNotIn(f":{taken}/", endpoint)

    def test_start_is_idempotent_and_refuses_when_not_installed(self):
        runtime = self.installed()
        first = runtime.start_engine()
        self.assertEqual(runtime.start_engine()["endpoint"], first["endpoint"])
        with self.assertRaises(VoiceError):
            self.runtime(root=self.root.parent / "empty").start_engine()

    def test_a_crashed_engine_is_restarted_once_and_then_left_alone(self):
        runtime = self.installed()
        runtime.start_engine()

        os.kill(runtime._process.pid, signal.SIGKILL)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and not (runtime.status()["running"] and runtime._restarts == 1):
            time.sleep(0.05)
        self.assertTrue(runtime.status()["running"], "restarted after the first crash")

        os.kill(runtime._process.pid, signal.SIGKILL)
        time.sleep(1.0)
        self.assertFalse(runtime.status()["running"], "not restarted after the second crash")

    def test_an_engine_that_dies_while_starting_reports_it_with_the_log_location(self):
        runtime = self.installed()
        binary = runtime.binary_path()
        binary.write_text(f"#!{sys.executable}\nimport sys\nprint('model failed to load')\nsys.exit(3)\n")
        binary.chmod(binary.stat().st_mode | stat.S_IXUSR)

        with self.assertRaises(VoiceError) as caught:
            runtime.start_engine()

        self.assertIn("stopped while starting", str(caught.exception))
        self.assertIn("model failed to load", (self.root / "logs" / "engine.log").read_text())
        self.assertFalse(runtime.status()["running"])

    def test_status_and_stop_stay_responsive_while_the_engine_is_still_starting(self):
        runtime = self.installed()
        with mock.patch.dict(os.environ, {"FAKE_ENGINE_DELAY": "3"}):
            outcome = {}
            starter = threading.Thread(target=lambda: outcome.update(error=self._start_error(runtime)))
            starter.start()
            time.sleep(0.6)
            began = time.monotonic()
            status = runtime.status()
            self.assertLess(time.monotonic() - began, 0.3)
            self.assertTrue(status["starting"])
            self.assertFalse(status["running"])
            began = time.monotonic()
            runtime.stop_engine()
            self.assertLess(time.monotonic() - began, 3)
            starter.join(10)
        self.assertIsNotNone(outcome["error"])

    @staticmethod
    def _start_error(runtime):
        try:
            runtime.start_engine()
        except VoiceError as error:
            return error
        return None

    def test_an_engine_killed_by_an_unsupported_instruction_names_the_processor(self):
        runtime = self.installed()
        with mock.patch.dict(os.environ, {"FAKE_ENGINE_MODE": "sigill"}):
            with self.assertRaises(VoiceError) as caught:
                runtime.start_engine()
        self.assertEqual(str(caught.exception), voice_runtime.UNSUPPORTED_CPU)
        self.assertEqual(runtime.status()["engineError"], voice_runtime.UNSUPPORTED_CPU)
        self.assertIn("processor", runtime.status()["engineError"])

    def test_the_pid_file_exists_while_running_and_a_stale_engine_is_stopped_on_the_next_start(self):
        runtime = self.installed()
        runtime.start_engine()
        self.assertEqual(json.loads(runtime.pid_path.read_text())["pid"], runtime._process.pid)
        stray = runtime._process
        # Pretend the app died without cleaning up: forget the process but leave it and its pid file.
        runtime._stopping = True
        runtime._process = None
        runtime._ready = False
        runtime._stopping = False
        self.assertIsNone(stray.poll())

        runtime.start_engine()

        self.assertIsNotNone(stray.wait(5), "the leftover engine was stopped")
        self.assertTrue(runtime.status()["running"])
        runtime.stop_engine()
        self.assertFalse(runtime.pid_path.exists())

    def test_an_unrelated_process_that_reuses_the_recorded_pid_is_left_alone(self):
        import subprocess

        runtime = self.installed()
        other = subprocess.Popen(["sleep", "30"])
        try:
            runtime.pid_path.write_text(json.dumps({"pid": other.pid, "binary": str(runtime.binary_path())}))
            runtime.start_engine()
            self.assertIsNone(other.poll())
        finally:
            other.kill()
            other.wait()

    @unittest.skipUnless(sys.platform.startswith("linux"), "PR_SET_PDEATHSIG is Linux-only")
    def test_the_engine_does_not_outlive_an_app_that_is_killed(self):
        import subprocess

        voice = self.root.parent / "orphan-voice"
        (voice / "engine" / "bin").mkdir(parents=True)
        binary = voice / "engine" / "bin" / voice_runtime.ENGINE_BINARY
        binary.write_text(FAKE_ENGINE)
        binary.chmod(0o755)
        (voice / "models").mkdir()
        (voice / "models" / MODEL_FILE).write_bytes(b"0123456789")
        (voice / "installed.json").write_text(json.dumps({"model": {"sha256": "x"}}))
        repo = Path(__file__).resolve().parent.parent
        script = (
            "import sys, time\nfrom pathlib import Path\nsys.path.insert(0, sys.argv[1])\n"
            "from voice_runtime import VoiceRuntime\n"
            "r = VoiceRuntime(root=Path(sys.argv[2]), key='linux-x86_64', model_bytes=10, model_sha256='x')\n"
            "r.start_engine()\nprint(r._process.pid, flush=True)\ntime.sleep(60)\n"
        )
        app = subprocess.Popen([sys.executable, "-c", script, str(repo), str(voice)], stdout=subprocess.PIPE, text=True)
        engine_pid = None
        try:
            engine_pid = int(app.stdout.readline())
            os.kill(engine_pid, 0)
            app.kill()
            app.wait()
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and voice_runtime._alive(engine_pid):
                time.sleep(0.05)
            self.assertFalse(voice_runtime._alive(engine_pid), "the engine stopped with its parent")
        finally:
            app.stdout.close()
            if app.poll() is None:
                app.kill()
            if engine_pid and voice_runtime._alive(engine_pid):
                os.kill(engine_pid, signal.SIGKILL)

    def test_autostart_starts_an_installed_engine_and_ignores_a_missing_one(self):
        self.runtime(root=self.root.parent / "nothing").autostart()  # must not raise
        runtime = self.installed()
        runtime.autostart()
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and not runtime.status()["running"]:
            time.sleep(0.05)
        self.assertTrue(runtime.status()["running"])


class VoiceApiTests(VoiceTestCase):
    HEADERS = {"X-Personal-Note": "1"}

    def setUp(self):
        super().setUp()
        self.source.publish_engine(engine_archive())
        self.voice = self.runtime()
        self.app = create_app(Path(self.temporary.name) / "personal-note.db", voice=self.voice)
        self.client = TestClient(self.app)

    def tearDown(self):
        self.client.close()
        super().tearDown()

    def test_status_install_and_remove_over_http(self):
        self.assertEqual(self.client.get("/api/voice/status").json()["state"], "not-installed")

        started = self.client.post("/api/voice/install", headers=self.HEADERS)
        self.assertEqual(started.status_code, 202)
        self.voice.wait_for_install(30)
        self.assertEqual(self.client.get("/api/voice/status").json()["state"], "ready")

        started = self.client.post("/api/voice/engine/start", headers=self.HEADERS)
        self.assertEqual(started.status_code, 200)
        self.assertTrue(started.json()["endpoint"].startswith("ws://127.0.0.1:"))

        removed = self.client.delete("/api/voice", headers=self.HEADERS)
        self.assertEqual(removed.json()["state"], "not-installed")
        self.assertFalse(self.root.exists())

    def test_changing_requests_need_the_app_header_so_other_sites_cannot_trigger_them(self):
        for call in (
            lambda: self.client.post("/api/voice/install"),
            lambda: self.client.post("/api/voice/engine/start"),
            lambda: self.client.delete("/api/voice"),
        ):
            self.assertEqual(call().status_code, 403)
        self.assertEqual(self.client.get("/api/voice/status").json()["state"], "not-installed")

    def test_cancel_is_a_separate_call_from_remove_and_needs_the_header(self):
        self.assertEqual(self.client.post("/api/voice/cancel").status_code, 403)
        response = self.client.post("/api/voice/cancel", headers=self.HEADERS)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["state"], "not-installed")

    def test_starting_an_engine_that_is_not_installed_is_a_readable_error(self):
        response = self.client.post("/api/voice/engine/start", headers=self.HEADERS)
        self.assertEqual(response.status_code, 409)
        self.assertIn("not installed", response.json()["error"])

    def test_installing_on_an_unsupported_system_is_a_readable_error(self):
        self.voice.key = None
        response = self.client.post("/api/voice/install", headers=self.HEADERS)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.client.get("/api/voice/status").json()["state"], "unsupported")


class HostGuardTests(unittest.TestCase):
    """DNS rebinding: a page on another name that resolves to 127.0.0.1 must not reach the local API."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.database = Path(self.temporary.name) / "n.db"
        self.voice = VoiceRuntime(root=Path(self.temporary.name) / "voice", key=KEY)

    def client(self, host: str, bound_host: str | None = "127.0.0.1") -> TestClient:
        app = create_app(self.database, voice=self.voice, bound_host=bound_host)
        client = TestClient(app, base_url=f"http://{host}")
        self.addCleanup(client.close)
        return client

    def test_loopback_names_with_any_port_are_served(self):
        for host in ("127.0.0.1:3138", "localhost:5173", "localhost", "[::1]:8080", "127.0.0.1"):
            self.assertEqual(self.client(host).get("/api/notebooks").status_code, 200, host)

    def test_any_other_host_name_is_refused_on_every_route(self):
        for host in ("evil.example:3138", "127.0.0.1.evil.example", "192.168.1.5:3138", "[::2]:80"):
            client = self.client(host)
            for path in ("/api/notebooks", "/api/voice/status", "/health", "/notes"):
                self.assertEqual(client.get(path).status_code, 403, f"{host} {path}")

    def test_a_server_bound_beyond_loopback_serves_any_host(self):
        self.assertEqual(self.client("notes.internal", bound_host="0.0.0.0").get("/api/notebooks").status_code, 200)
        self.assertEqual(self.client("notes.internal", bound_host=None).get("/api/notebooks").status_code, 200)


if __name__ == "__main__":
    unittest.main()
