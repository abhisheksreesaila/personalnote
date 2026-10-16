"""Optional local search by meaning: download, verify and run the embedding engine.

Standard library only. The engine is the official llama.cpp server (`llama-server`) and the model is EmbeddingGemma 2
(Q8 GGUF). It only runs while the app is open, on a loopback port, started the first time something is embedded.
Nothing here touches the notebook database; indexing and search use `SearchRuntime.embed` (F-079, F-080).

It mirrors voice_runtime.py (pinned downloads, `.part` files that resume, `installed.json` written last) and reuses
that module's checksum, process-reaping and die-with-parent helpers.

Layout, under the search folder (beside the database, `search-by-meaning/`):

    engine/llama-server (+ libraries)   unpacked from the release asset; only the server and its libraries are kept
    engine/.pin                         the sha256 of the archive the folder came from
    models/<MODEL_FILE>                 the embedding model, downloaded from Hugging Face
    installed.json                      written last, only when engine and model both verified
    logs/engine.log                     the engine's own output
    *.part                              partial downloads, kept so a download can resume
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import re
import secrets
import shutil
import signal
import socket
import subprocess
import tarfile
import threading
import time
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import voice_runtime
from chromium_app import child_env
from voice_runtime import platform_key

logger = logging.getLogger("personal-note.search")

HOST = "127.0.0.1"
USER_AGENT = "personal-note-search-installer"
CHUNK = 1024 * 64
LOG_LIMIT = 1024 * 1024
DOWNLOAD_LABEL = "about 315 MB"
DIMENSION = 256  # EmbeddingGemma is Matryoshka-trained: its first 256 numbers, renormalised, keep nearly all the quality
RETRY_AFTER_FAILED_START = 60.0  # seconds before an engine that would not start is tried again
NOT_AVAILABLE = "Search by meaning is not available on this system."
CLOSING = "The app is closing; search by meaning is stopped."
CONTEXT_TOKENS = 2048  # the engine is started with -c 2048 -ub 2048: an input over this is refused, not cut
TOKEN_BUDGET = 1990  # what a prompt is cut to; the engine adds a start and an end token
ENGINE_NICE = 10  # the engine runs this much nicer than the app
SAFE_BYTES = 1800  # a token covers at least one byte, so a prompt this short can never be over the context: no counting needed

# Environment override, for tests and mirrors; not reachable from the page. A JSON file holding
# {"engine": {url, bytes, sha256}, "model": {url, bytes, sha256}}. Sizes and checksums are still checked.
ENV_MANIFEST = "PERSONAL_NOTE_SEARCH_MANIFEST"
ENV_DIR = "PERSONAL_NOTE_SEARCH_DIR"


@dataclass(frozen=True)
class Pin:
    url: str
    bytes: int
    sha256: str


LLAMA_RELEASE = "b11681"
_RELEASE_URL = f"https://github.com/ggml-org/llama.cpp/releases/download/{LLAMA_RELEASE}"
ENGINE_PINS = {
    "linux-x86_64": Pin(f"{_RELEASE_URL}/llama-{LLAMA_RELEASE}-bin-ubuntu-x64.tar.gz", 17880401, "a3f47bfd4bc91181534e87bfa24161205fdef91adcd0a026d20e683241b2ba7d"),
    "macos-arm64": Pin(f"{_RELEASE_URL}/llama-{LLAMA_RELEASE}-bin-macos-arm64.tar.gz", 12220443, "a98b30f90e2c01d34dcc6bf49d4cd20936a72735e3101aaa421424abeae42f3e"),
}
MODEL_REPO = "ggml-org/embeddinggemma-2-GGUF"
MODEL_REVISION = "bfcd298762cc34d0357ece5ebdd31791a3a374d8"
MODEL_FILE = "embeddinggemma-2-Q8_0.gguf"
MODEL_PIN = Pin(
    f"https://huggingface.co/{MODEL_REPO}/resolve/{MODEL_REVISION}/{MODEL_FILE}",
    309855456,
    "2188ac1deca4b77dffefd603c2776a9d76d9d74ec01841392982ebb840b09135",
)
SERVER_BINARY = "llama-server"
KEEP_FILES = {SERVER_BINARY, "LICENSE"}  # and every lib*; the release also ships ~40 tools the app never runs


class SearchError(Exception):
    """A search-by-meaning problem with a message that is safe to show the user."""


class SearchInputError(SearchError):
    """The engine is up but refused this input (too long for its context). Trying other inputs is fine; this one will not work."""


class _Cancelled(Exception):
    pass


class _NotFound(SearchError):
    pass


def document_prompt(title: str | None, text: str) -> str:
    return f"title: {title or 'none'} | text: {text}"


def query_prompt(query: str) -> str:
    return f"task: search result | query: {query}"


def _manifest_pins() -> tuple[Pin | None, Pin | None]:
    path = os.environ.get(ENV_MANIFEST)
    if not path:
        return None, None
    manifest = json.loads(Path(path).read_text(encoding="utf-8"))
    return Pin(**manifest["engine"]), Pin(**manifest["model"])


@dataclass
class _Progress:
    state: str = "idle"  # idle | downloading | error
    phase: str = ""  # engine | model | verifying
    done: int = 0  # bytes of finished steps
    current: int = 0  # bytes of the step in progress
    error: str = ""


@dataclass
class SearchRuntime:
    root: Path
    key: str | None = field(default_factory=platform_key)
    engine: Pin | None = None
    model: Pin | None = None
    dimension: int = DIMENSION
    opener: Callable = urlopen
    ready_timeout: float = 60.0
    threads: int | None = None  # the engine's CPU threads; default leaves most of the machine to the person typing
    clock: Callable = time.monotonic
    pid_name: str = "engine.pid"  # the command line (F-080) uses its own, so starting its engine never stops the running app's

    def __post_init__(self):
        if self.threads is None:
            self.threads = max(1, min(4, (os.cpu_count() or 2) // 2))
        self._closed = False
        self._last_used = self.clock()
        self.root = Path(self.root)
        engine, model = _manifest_pins()
        self.engine = self.engine or engine or ENGINE_PINS.get(self.key)
        self.model = self.model or model or MODEL_PIN
        if self.engine is None:
            self.key = None
        self._lock = threading.RLock()
        self._progress = _Progress()
        self._cancel = threading.Event()
        self._worker: threading.Thread | None = None
        self._process: subprocess.Popen | None = None
        self._port: int | None = None
        self._ready = False
        self._engine_error = ""
        self._api_key = ""  # new for every launch; the engine reads it from its environment, so it is not in `ps`
        self._retry_after = 0.0
        self._start_lock = threading.Lock()
        self._loopback = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # never through a proxy

    # ---- paths ---------------------------------------------------------------------------

    @property
    def engine_dir(self) -> Path:
        return self.root / "engine"

    @property
    def binary_path(self) -> Path:
        return self.engine_dir / SERVER_BINARY

    @property
    def model_path(self) -> Path:
        return self.root / "models" / MODEL_FILE

    @property
    def marker_path(self) -> Path:
        return self.root / "installed.json"

    @property
    def log_path(self) -> Path:
        return self.root / "logs" / "engine.log"

    @property
    def pid_path(self) -> Path:
        return self.root / self.pid_name

    @property
    def _archive_path(self) -> Path:
        return self.root / "downloads" / "engine.tar.gz"

    @staticmethod
    def _part(path: Path) -> Path:
        return path.with_name(path.name + ".part")

    # ---- status --------------------------------------------------------------------------

    def installed(self) -> bool:
        try:
            marker = json.loads(self.marker_path.read_text(encoding="utf-8"))
            return (
                marker.get("model", {}).get("sha256") == self.model.sha256
                and marker.get("engine", {}).get("sha256") == self.engine.sha256
                and self.binary_path.is_file()
                and self.model_path.stat().st_size == self.model.bytes
            )
        except (OSError, ValueError, AttributeError):
            return False

    @property
    def model_id(self) -> str:
        """Names the model and its vector length; stored vectors from any other are rebuilt."""
        return f"{MODEL_REPO}@{MODEL_REVISION[:8]}/{self.dimension}"

    def _partial_bytes(self) -> int:
        total = 0
        for part in (self._part(self._archive_path), self._part(self.model_path)):
            try:
                total += part.stat().st_size
            except OSError:
                pass
        return total

    def _running(self) -> bool:
        process = self._process
        return process is not None and process.poll() is None and self._port is not None and self._ready

    def status(self) -> dict:
        with self._lock:
            running = self._running()
            base = {
                "supported": self.key is not None,
                "platform": self.key,
                "downloadLabel": DOWNLOAD_LABEL,
                "running": running,
                "endpoint": f"http://{HOST}:{self._port}" if running else None,
                "percent": None,
                "phase": "",
                "error": "",
                "partialBytes": 0,
                "engineError": self._engine_error,
            }
            if self.key is None:
                return base | {"state": "unsupported"}
            progress = self._progress
            if progress.state == "downloading":
                total = max(self.engine.bytes + self.model.bytes, 1)
                return base | {"state": "downloading", "phase": progress.phase, "percent": min(99, int((progress.done + progress.current) * 100 / total))}
            if progress.state == "error":
                return base | {"state": "error", "error": progress.error, "partialBytes": self._partial_bytes()}
            if self.installed():
                return base | {"state": "ready", "percent": 100}
            if self.marker_path.exists():
                return base | {"state": "error", "error": "The search files on this computer are damaged. Download them again."}
            return base | {"state": "not-installed", "partialBytes": self._partial_bytes()}

    # ---- install -------------------------------------------------------------------------

    def start_install(self) -> dict:
        """Begin downloading in the background. Idempotent while a download runs; resumes partial files."""
        if self.key is None:
            raise SearchError(NOT_AVAILABLE)
        with self._lock:
            if self._worker and self._worker.is_alive():
                return self.status()
            if self.installed():
                return self.status()
            self._cancel.clear()
            self._progress = _Progress(state="downloading", phase="engine")
            self._worker = threading.Thread(target=self._install, name="personal-note-search-install", daemon=True)
            self._worker.start()
        return self.status()

    def wait_for_install(self, timeout: float = 60.0) -> None:
        worker = self._worker
        if worker:
            worker.join(timeout)

    def cancel_install(self) -> dict:
        """Stop a running download but keep the partial files, so pressing Download again resumes."""
        self._cancel.set()
        worker = self._worker
        if worker:
            worker.join(10)
        return self.status()

    def _install(self) -> None:
        try:
            self.marker_path.unlink(missing_ok=True)  # a half-repaired install must not look installed
            self._install_engine()
            self._install_model()
            self._set_phase("verifying")
            self._write_marker({
                "platform": self.key,
                "engine": {"sha256": self.engine.sha256},
                "model": {"file": MODEL_FILE, "bytes": self.model.bytes, "sha256": self.model.sha256},
            })
            with self._lock:
                self._progress = _Progress()
        except _Cancelled:
            with self._lock:
                self._progress = _Progress()
        except SearchError as error:
            logger.warning("Search install failed: %s", error)
            self._fail(str(error))
        except Exception as error:  # a bug must still end as a visible error, never a stuck progress bar
            logger.exception("Search install crashed")
            self._fail(f"Search by meaning could not be set up ({type(error).__name__}). Try again.")

    def _fail(self, message: str) -> None:
        with self._lock:
            self._progress = _Progress(state="error", error=message)

    def _write_marker(self, marker: dict) -> None:
        temporary = self.marker_path.with_name(self.marker_path.name + ".tmp")
        temporary.write_text(json.dumps(marker), encoding="utf-8")
        os.replace(temporary, self.marker_path)

    def _set_phase(self, phase: str, done: int | None = None) -> None:
        with self._lock:
            self._progress.phase = phase
            if phase != "verifying":  # the bar stays where it was while the checksum runs
                self._progress.current = 0
            if done is not None:
                self._progress.done = done

    def _check_cancel(self) -> None:
        if self._cancel.is_set():
            raise _Cancelled()

    def _install_engine(self) -> None:
        pin_file = self.engine_dir / ".pin"
        try:
            if self.binary_path.is_file() and pin_file.read_text(encoding="utf-8") == self.engine.sha256:
                self._set_phase("model", done=self.engine.bytes)  # a verified engine from an earlier try
                return
        except OSError:
            pass
        self._set_phase("engine")
        archive = self._archive_path
        self._download(self.engine, archive, "engine")
        self._unpack_engine(archive)
        pin_file.write_text(self.engine.sha256, encoding="utf-8")
        archive.unlink(missing_ok=True)
        try:
            archive.parent.rmdir()
        except OSError:
            pass
        self._set_phase("model", done=self.engine.bytes)

    def _install_model(self) -> None:
        path = self.model_path
        if path.is_file():
            self._set_phase("verifying")
            if path.stat().st_size == self.model.bytes and _sha256(path) == self.model.sha256:
                return
            path.unlink()
            self._set_phase("model")
        self._download(self.model, path, "model")

    # ---- http ----------------------------------------------------------------------------

    def _request(self, url: str, headers: dict | None = None):
        request = Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
        try:
            return self.opener(request, timeout=30)
        except HTTPError as error:
            error.close()
            if error.code == 404:
                raise _NotFound("A file Personal Note needs could not be found on the download server.") from error
            if error.code == 416:
                raise
            raise SearchError(f"The download server answered {error.code}. Try again later.") from error
        except (URLError, OSError, TimeoutError) as error:
            raise SearchError("Could not reach the download server. Check your connection and try again.") from error

    def _download(self, pin: Pin, target: Path, what: str) -> None:
        """Download to `<target>.part` (resuming), check size and sha256, then move it to `target`."""
        target.parent.mkdir(parents=True, exist_ok=True)
        part = self._part(target)
        have = part.stat().st_size if part.exists() else 0
        if have > pin.bytes:
            part.unlink()
            have = 0
        if have < pin.bytes:
            self._fetch(pin.url, part, have, pin.bytes)
        self._set_phase("verifying")
        if part.stat().st_size != pin.bytes or _sha256(part) != pin.sha256:
            part.unlink(missing_ok=True)
            raise SearchError(f"The downloaded search {what} failed its size and checksum check. Nothing was installed; try again.")
        os.replace(part, target)

    def _fetch(self, url: str, part: Path, have: int, expected: int) -> None:
        headers = {"Range": f"bytes={have}-"} if have else {}
        try:
            response = self._request(url, headers)
        except HTTPError:  # 416: the partial file is not a prefix we can extend
            part.unlink(missing_ok=True)
            have = 0
            response = self._request(url)
        with response:
            if getattr(response, "status", 200) != 206 and have:
                have = 0  # the server ignored the range: start over
            with open(part, "ab" if have else "wb") as handle:
                written = have
                while True:
                    self._check_cancel()
                    try:
                        block = response.read(CHUNK)
                    except (OSError, TimeoutError) as error:
                        raise SearchError("The download was interrupted. Try again to resume it.") from error
                    if not block:
                        break
                    written += len(block)
                    if written > expected:  # a bad mirror must not fill the disk beside the database
                        handle.close()
                        part.unlink(missing_ok=True)
                        raise SearchError("The download server sent more than expected. Nothing was installed.")
                    handle.write(block)
                    with self._lock:
                        self._progress.current = written
        if written != expected:
            raise SearchError("The download was interrupted. Try again to resume it.")

    # ---- unpack --------------------------------------------------------------------------

    def _unpack_engine(self, archive: Path) -> None:
        """Keep the server and its libraries, flat, in engine/. Nothing may land outside that folder."""
        unsafe = SearchError("The search engine archive is not safe to unpack.")
        staging = self.root / "engine.new"
        shutil.rmtree(staging, ignore_errors=True)
        staging.mkdir(parents=True)
        try:
            with tarfile.open(archive, "r:gz") as bundle:
                members = bundle.getmembers()
                for member in members:
                    parts = Path(member.name).parts
                    if member.name.startswith("/") or ".." in parts:
                        raise unsafe
                    if not (member.isfile() or member.isdir() or member.issym()):
                        raise unsafe
                    if member.issym() and (not re.fullmatch(r"[A-Za-z0-9._+-]+", member.linkname) or member.linkname.startswith(".")):
                        raise unsafe  # a link may only name a file beside it, never a path
                for member in members:
                    parts = Path(member.name).parts
                    name = parts[-1] if len(parts) == 2 else ""
                    if not name or member.isdir() or not (name in KEEP_FILES or name.startswith("lib")):
                        continue
                    destination = staging / name
                    if member.issym():
                        os.symlink(member.linkname, destination)
                    else:
                        with bundle.extractfile(member) as source, open(destination, "wb") as handle:
                            shutil.copyfileobj(source, handle)
                        destination.chmod(0o755 if name == SERVER_BINARY or ".so" in name or ".dylib" in name else 0o644)
        except (tarfile.TarError, OSError) as error:
            shutil.rmtree(staging, ignore_errors=True)
            raise SearchError("The search engine archive could not be unpacked. Try again.") from error
        except SearchError:
            shutil.rmtree(staging, ignore_errors=True)
            raise
        if not (staging / SERVER_BINARY).is_file():
            shutil.rmtree(staging, ignore_errors=True)
            raise SearchError("The search engine archive does not contain the engine.")
        shutil.rmtree(self.engine_dir, ignore_errors=True)
        os.replace(staging, self.engine_dir)

    # ---- engine process ------------------------------------------------------------------
    #
    # One supervisor thread per engine run starts the process and waits for it (Linux's PR_SET_PDEATHSIG fires when
    # the *thread* that started the child ends, and request threads are short-lived). `_start_lock` serialises start
    # attempts; `_lock` guards state only and is never held while waiting.

    def _choose_port(self) -> int:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind((HOST, 0))
            return probe.getsockname()[1]

    def _command(self, port: int) -> list[str]:
        return [
            str(self.binary_path), "-m", str(self.model_path), "--embedding", "--pooling", "mean",
            "--host", HOST, "--port", str(port), "-c", str(CONTEXT_TOKENS), "-ub", str(CONTEXT_TOKENS), "-np", "1", "-t", str(self.threads), "--no-webui", "--no-slots",
        ]

    @staticmethod
    def _child_setup(parent: int) -> None:
        """Runs in the engine's process before it starts: low priority (it is a background job; typing comes first), and die with the app."""
        try:
            os.nice(ENGINE_NICE)
        except OSError:
            pass
        if voice_runtime._PRCTL:
            voice_runtime._die_with_parent(parent)

    def _launch_prefix(self) -> list[str]:
        """On a Mac, `taskpolicy -b` also puts the engine on the efficiency cores and lowers its disk and network priority."""
        tool = shutil.which("taskpolicy") if (self.key or "").startswith("macos") else None
        return [tool, "-b"] if tool else []

    def _open_log(self):
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        if self.log_path.exists() and self.log_path.stat().st_size > LOG_LIMIT:
            self.log_path.replace(self.log_path.with_name("engine.log.1"))
        return open(self.log_path, "ab")

    def _supervise(self, port: int, spawned: threading.Event, outcome: dict) -> None:
        env = child_env() | {"LLAMA_API_KEY": self._api_key}
        if self.key == "linux-x86_64":  # the libraries sit beside the server
            env["LD_LIBRARY_PATH"] = os.pathsep.join(filter(None, [str(self.engine_dir), env.get("LD_LIBRARY_PATH", "")]))
        try:
            with self._open_log() as log:
                try:
                    process = subprocess.Popen(
                        self._launch_prefix() + self._command(port), cwd=self.engine_dir, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                        preexec_fn=(lambda parent=os.getpid(): self._child_setup(parent)) if (self.key or "").startswith("linux") else None,  # a Mac relies on `taskpolicy -b`: preexec_fn is unsafe with threads
                    )
                except OSError as error:
                    outcome["error"] = SearchError("The search engine could not be started. Download search by meaning again.")
                    outcome["error"].__cause__ = error
                    spawned.set()
                    return
                with self._lock:
                    self._process, self._port, self._ready = process, port, False
                try:
                    self.pid_path.write_text(json.dumps({"pid": process.pid, "binary": str(self.binary_path)}), encoding="utf-8")
                except OSError:
                    pass
                outcome["process"] = process
                spawned.set()
                process.wait()
        finally:
            spawned.set()
            with self._lock:
                if self._process is not None and self._process.poll() is not None:
                    self._process = self._port = None
                    self._ready = False

    def _await_ready(self, process: subprocess.Popen, port: int) -> None:
        deadline = time.monotonic() + self.ready_timeout
        while time.monotonic() < deadline:
            code = process.poll()
            if code is not None:
                if code == -signal.SIGILL:
                    raise SearchError("This computer's processor isn't supported by the search engine.")
                raise SearchError("The search engine stopped while starting. Its log is in the search folder.")
            try:
                with self._loopback.open(f"http://{HOST}:{port}/health", timeout=1) as response:
                    if response.status == 200:
                        with self._lock:
                            if self._process is process:
                                self._ready = True
                        return
            except (OSError, URLError):  # 503 while the model loads, or not listening yet
                time.sleep(0.05)
        raise SearchError("The search engine did not become ready in time.")

    def _ensure_started(self) -> int:
        with self._start_lock:
            if self._closed:
                raise SearchError(CLOSING)
            if self._running():
                return self._port
            if self.key is None:
                raise SearchError(NOT_AVAILABLE)
            if not self.installed():
                raise SearchError("Search by meaning is not installed. Download it in Settings.")
            if time.monotonic() < self._retry_after:
                raise SearchError(self._engine_error)
            voice_runtime.reap_stale_process(self.pid_path)
            self._api_key = secrets.token_urlsafe(32)
            port = self._choose_port()
            if self._closed:  # the app began closing while this was starting: spawn nothing
                raise SearchError(CLOSING)
            spawned = threading.Event()
            outcome: dict = {}
            threading.Thread(target=self._supervise, args=(port, spawned, outcome), name="personal-note-search-engine", daemon=True).start()
            spawned.wait()
            try:
                if "error" in outcome:
                    raise outcome["error"]
                if self._closed:  # shutdown ran before the process was registered, so it could not stop it
                    raise SearchError(CLOSING)
                self._await_ready(outcome["process"], port)
                if self._closed:
                    raise SearchError(CLOSING)
            except SearchError as error:
                process = outcome.get("process")
                with self._lock:
                    self._engine_error = str(error)
                    self._retry_after = time.monotonic() + RETRY_AFTER_FAILED_START
                    self._process = self._port = None
                    self._ready = False
                if process is not None:
                    self._terminate(process)
                raise
            with self._lock:
                self._engine_error = ""
            return port

    @staticmethod
    def _terminate(process: subprocess.Popen) -> None:
        if process.poll() is not None:
            return
        process.terminate()
        try:
            process.wait(5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(5)

    def stop_engine(self) -> None:
        with self._lock:
            process, self._process, self._port, self._ready = self._process, None, None, False
        if process is not None:
            self._terminate(process)
        self.pid_path.unlink(missing_ok=True)

    def shutdown(self) -> None:
        """The app is closing: stop the engine for good. Nothing can start it again (a background embed may be racing this)."""
        self._closed = True
        self.stop_engine()

    def stop_if_idle(self, seconds: float) -> bool:
        """Stop the engine when nothing has embedded for `seconds`; the next embed starts it again. True when it was stopped."""
        with self._lock:
            if not self._running() or self.clock() - self._last_used < seconds:
                return False
        self.stop_engine()
        return True

    # ---- embedding -----------------------------------------------------------------------

    def embed(self, texts: list, kind: str = "document") -> list[list[float]]:
        """Embed texts, in order. A document is `(title, text)` or a bare text (no title); a query is a bare text.

        Starts the engine the first time. Vectors are cut to `dimension` numbers and scaled to length 1, so the
        dot product of two of them is their cosine similarity. Raises SearchError; the caller keeps working without.
        """
        if kind not in ("document", "query"):
            raise ValueError("kind is 'document' or 'query'")
        if not texts:
            return []
        prompts = [query_prompt(item) if kind == "query" else document_prompt(*(item if isinstance(item, tuple) else (None, item))) for item in texts]
        self._last_used = self.clock()
        port = self._ensure_started()
        prompts = [self._fit(prompt, port) for prompt in prompts]
        request = Request(
            f"http://{HOST}:{port}/v1/embeddings", data=json.dumps({"input": prompts}).encode(),
            headers={"Content-Type": "application/json", "User-Agent": USER_AGENT, "Authorization": f"Bearer {self._api_key}"},
        )
        try:
            with self._loopback.open(request, timeout=120) as response:
                data = json.load(response)["data"]
        except HTTPError as error:
            if error.code in (400, 413, 500) and b"too large" in error.read(2000):  # the engine answered: this input is the problem
                raise SearchInputError("That note is too long for the search engine.") from error
            raise SearchError("The search engine did not answer. Try again.") from error
        except (OSError, URLError, ValueError, KeyError) as error:
            raise SearchError("The search engine did not answer. Try again.") from error
        finally:
            self._last_used = self.clock()
        if len(data) != len(prompts):
            raise SearchError("The search engine answered with the wrong number of results.")
        return [self._shape(item["embedding"]) for item in sorted(data, key=lambda item: item["index"])]

    def _fit(self, prompt: str, port: int) -> str:
        """Cut a prompt to the engine's context: the engine refuses an over-long input instead of cutting it (HTTP 500).

        Dense text (CJK, URLs, minified code) runs to 2 or more tokens per character, so the length is counted by the engine.
        A short prompt needs no counting: a token covers at least one byte.
        """
        if len(prompt.encode()) <= SAFE_BYTES:
            return prompt
        try:
            for _ in range(8):
                count = self._count_tokens(prompt, port)
                if count <= TOKEN_BUDGET:
                    return prompt
                prompt = prompt[: max(1, int(len(prompt) * TOKEN_BUDGET / count * 0.98))]
        except (OSError, URLError, ValueError, KeyError):
            pass  # cannot count: fall back to a length that is under the context whatever the text
        return prompt.encode()[:SAFE_BYTES].decode(errors="ignore")

    def _count_tokens(self, text: str, port: int) -> int:
        request = Request(
            f"http://{HOST}:{port}/tokenize", data=json.dumps({"content": text}).encode(),
            headers={"Content-Type": "application/json", "User-Agent": USER_AGENT, "Authorization": f"Bearer {self._api_key}"},
        )
        with self._loopback.open(request, timeout=30) as response:
            return len(json.load(response)["tokens"])

    def _shape(self, vector: list[float]) -> list[float]:
        if len(vector) < self.dimension:
            raise SearchError("The search engine returned shorter vectors than expected.")
        cut = vector[: self.dimension]
        norm = math.sqrt(sum(value * value for value in cut))
        if norm == 0:
            raise SearchError("The search engine returned an empty vector.")
        return [value / norm for value in cut]


def default_search_runtime(database_path: Path, **options) -> SearchRuntime:
    """Search by meaning lives beside the database (PERSONAL_NOTE_SEARCH_DIR overrides it), so a scratch database gets a scratch folder."""
    folder = os.environ.get("PERSONAL_NOTE_SEARCH_DIR")
    return SearchRuntime(root=Path(folder) if folder else Path(database_path).parent / "search-by-meaning", **options)


def reap_dead_cli_engines(root: Path) -> None:
    """Stop engines that `personal-note search --meaning` commands left behind when they died (`engine-cli-<pid>.pid` names the command);
    an engine whose command is still running is never touched."""
    for record in Path(root).glob("engine-cli-*.pid"):
        owner = record.name[len("engine-cli-"):-len(".pid")]
        if not owner.isdigit() or not voice_runtime._alive(int(owner)):
            voice_runtime.reap_stale_process(record)


def _sha256(path: Path) -> str:
    return voice_runtime._sha256(path)
