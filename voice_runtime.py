"""Optional local voice: download, verify, remove and run the speech engine.

Standard library only. Nothing here touches the notebook database or stores audio; audio only ever flows from
the page to the engine over loopback (docs/ARCHITECTURE.md, "Optional built-in voice capture").

Layout, under the voice folder (app data `voice/`):

    engine/bin/nemo-speech (+ libraries)   the engine, unpacked from the release asset
    models/<MODEL_FILE>                    the speech model, downloaded from Hugging Face
    installed.json                         written last, only when engine and model both verified
    logs/engine.log                        the engine's own output
    *.part                                 partial downloads, kept so a download can resume
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import platform
import shutil
import signal
import socket
import subprocess
import sys
import tarfile
import threading
import time
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from chromium_app import child_env

logger = logging.getLogger("personal-note.voice")

# The engine is NVIDIA NeMo-Speech.cpp at this commit; the release workflow builds exactly this one.
ENGINE_COMMIT = "b00a5537c71059cf49c1d8e11609af7abd6b4b0b"
MODEL_REPO = "nvidia/nemotron-3.5-asr-streaming-0.6b"
MODEL_REVISION = "ea30d66debe3740a08b573244286791d423d6b3e"
MODEL_FILE = "nemotron-3.5-asr-streaming-0.6b.q8_0.gguf"
MODEL_BYTES = 742090464
MODEL_SHA256 = "3fc991d3badad7277c11030a7519832cddaf2057aafed6d4b25147e953a070b1"
MODEL_URL = f"https://huggingface.co/{MODEL_REPO}/resolve/{MODEL_REVISION}/{MODEL_FILE}"
RELEASES_URL = "https://github.com/abhisheksreesaila/personalnote/releases"
ENGINE_BINARY = "nemo-speech"
PREFERRED_PORT = 8080  # the engine's own default; another port is used when something else holds it
HOST = "127.0.0.1"
DOWNLOAD_LABEL = "about 750 MB"
USER_AGENT = "personal-note-voice-installer"
CHUNK = 1024 * 256
LOG_LIMIT = 1024 * 1024
SETTINGS_FILE = "settings.json"
UNSUPPORTED_CPU = "This computer's processor isn't supported by the voice engine."

# Environment overrides, for tests, mirrors and development; none of them is reachable from the page.
ENV_ENGINE_URL = "PERSONAL_NOTE_VOICE_ENGINE_URL"  # folder holding the engine asset and its .sha256
ENV_MODEL_URL = "PERSONAL_NOTE_VOICE_MODEL_URL"


class VoiceError(Exception):
    """A voice problem with a message that is safe to show the user."""


def platform_key(system: str | None = None, machine: str | None = None) -> str | None:
    """`linux-x86_64` or `macos-arm64`: the engines the release builds. None where voice is not offered."""
    system = (platform.system() if system is None else system).lower()
    machine = (platform.machine() if machine is None else machine).lower()
    machine = {"amd64": "x86_64", "aarch64": "arm64"}.get(machine, machine)
    if system == "linux" and machine == "x86_64":
        return "linux-x86_64"
    if system == "darwin" and machine == "arm64":
        return "macos-arm64"
    return None


def engine_asset(key: str) -> str:
    return f"personal-note-voice-engine-{key}.tar.gz"


def app_version(root: Path) -> str | None:
    """The released version this app was built as, or None in a checkout."""
    for candidate in (root / "app_version.txt",):
        try:
            value = candidate.read_text(encoding="utf-8").strip().lstrip("v")
        except OSError:
            continue
        if value and value != "0.0.0":
            return value
    return None


def engine_base_urls(version: str | None, override: str | None = None) -> list[str]:
    """Where to look for the engine asset, best first: a configured folder, this version's release, the latest."""
    if override:
        return [override.rstrip("/")]
    urls = []
    if version:
        urls.append(f"{RELEASES_URL}/download/v{version}")
    urls.append(f"{RELEASES_URL}/latest/download")
    return urls


@dataclass
class _Progress:
    state: str = "idle"  # idle | downloading | error
    phase: str = ""  # engine | model | verifying
    done: int = 0  # bytes of finished steps
    current: int = 0  # bytes of the step in progress
    total: int = 0
    error: str = ""


@dataclass
class VoiceRuntime:
    root: Path
    key: str | None = field(default_factory=platform_key)
    version: str | None = None
    engine_url: str | None = None  # overrides every default and the settings file
    model_url: str = MODEL_URL
    model_bytes: int = MODEL_BYTES
    model_sha256: str = MODEL_SHA256
    opener: Callable = urlopen
    ready_timeout: float = 90.0
    preferred_port: int = PREFERRED_PORT

    def __post_init__(self):
        self.root = Path(self.root)
        self._lock = threading.RLock()
        self._progress = _Progress()
        self._cancel = threading.Event()
        self._worker: threading.Thread | None = None
        self._process: subprocess.Popen | None = None
        self._port: int | None = None
        self._log = None
        self._stopping = False
        self._ready = False
        self._restarts = 0
        self._engine_error = ""
        self._start_lock = threading.Lock()

    # ---- paths ---------------------------------------------------------------------------

    @property
    def engine_dir(self) -> Path:
        return self.root / "engine"

    @property
    def model_path(self) -> Path:
        return self.root / "models" / MODEL_FILE

    @property
    def marker_path(self) -> Path:
        return self.root / "installed.json"

    @property
    def log_path(self) -> Path:
        return self.root / "logs" / "engine.log"

    def binary_path(self) -> Path:
        return self.engine_dir / "bin" / ENGINE_BINARY

    # ---- status --------------------------------------------------------------------------

    def installed(self) -> bool:
        try:
            marker = json.loads(self.marker_path.read_text(encoding="utf-8"))
            return (
                marker.get("model", {}).get("sha256") == self.model_sha256
                and self.binary_path().is_file()
                and self.model_path.stat().st_size == self.model_bytes
            )
        except (OSError, ValueError, AttributeError):
            return False

    def _engine_note(self) -> str:
        """Said when the downloaded engine is a different build than this app pins; it is kept and still used."""
        try:
            found = json.loads(self.marker_path.read_text(encoding="utf-8")).get("engine", {}).get("commit")
        except (OSError, ValueError, AttributeError):
            return ""
        if found and found != ENGINE_COMMIT:
            return f"The voice engine is build {found[:8]}, not the {ENGINE_COMMIT[:8]} this version expects. It is kept and used."
        return ""

    def _partial_bytes(self) -> int:
        total = 0
        for part in (self._part(self._engine_target()), self._part(self.model_path)):
            try:
                total += part.stat().st_size
            except OSError:
                pass
        return total

    def _engine_target(self) -> Path:
        return self.root / "downloads" / (engine_asset(self.key) if self.key else "engine")

    @staticmethod
    def _part(path: Path) -> Path:
        return path.with_name(path.name + ".part")

    def status(self) -> dict:
        with self._lock:
            progress = self._progress
            running = self._running()
            base = {
                "supported": self.key is not None,
                "platform": self.key,
                "downloadLabel": DOWNLOAD_LABEL,
                "running": running,
                "endpoint": f"ws://{HOST}:{self._port}/v1/realtime" if running else None,
                "percent": None,
                "phase": "",
                "error": "",
                "partialBytes": 0,
                "starting": self._process is not None and not self._ready,
                "engineError": self._engine_error,
                "note": self._engine_note(),
            }
            if self.key is None:
                return base | {"state": "unsupported"}
            if progress.state == "downloading":
                done = progress.done + progress.current
                total = max(progress.total, done, 1)
                return base | {"state": "downloading", "phase": progress.phase, "percent": min(99, int(done * 100 / total))}
            if progress.state == "error":
                return base | {"state": "error", "error": progress.error, "partialBytes": self._partial_bytes()}
            if self.installed():
                return base | {"state": "ready", "percent": 100}
            return base | {"state": "not-installed", "partialBytes": self._partial_bytes()}

    # ---- install -------------------------------------------------------------------------

    def start_install(self) -> dict:
        """Begin downloading in the background. Idempotent while a download runs; resumes partial files."""
        if self.key is None:
            raise VoiceError("Voice download is not available on this system.")
        with self._lock:
            if self._worker and self._worker.is_alive():
                return self.status()
            if self.installed():
                return self.status()
            self._cancel.clear()
            self._progress = _Progress(state="downloading", phase="engine")
            self._worker = threading.Thread(target=self._install, name="personal-note-voice-install", daemon=True)
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

    def _fail(self, message: str) -> None:
        with self._lock:
            self._progress = _Progress(state="error", error=message)

    def _install(self) -> None:
        try:
            self._download_engine()
            self._download_model()
            self._set_phase("verifying")
            self.marker_path.parent.mkdir(parents=True, exist_ok=True)
            marker = {
                "engine": {"commit": self._unpacked_engine_commit()},
                "platform": self.key,
                "model": {"file": MODEL_FILE, "bytes": self.model_bytes, "sha256": self.model_sha256},
            }
            self._write_marker(marker)
            with self._lock:
                self._progress = _Progress()
        except _Cancelled:
            with self._lock:
                self._progress = _Progress()
        except VoiceError as error:
            logger.warning("Voice install failed: %s", error)
            self._fail(str(error))
        except Exception as error:  # a bug must still end as a visible error, never a stuck progress bar
            logger.exception("Voice install crashed")
            self._fail(f"Voice setup failed unexpectedly ({type(error).__name__}). Try again.")

    def _unpacked_engine_commit(self) -> str | None:
        try:
            value = json.loads((self.engine_dir / "engine.json").read_text(encoding="utf-8")).get("commit")
        except (OSError, ValueError, AttributeError):
            return None
        return value if isinstance(value, str) else None

    def _write_marker(self, marker: dict) -> None:
        temporary = self.marker_path.with_name(self.marker_path.name + ".tmp")
        temporary.write_text(json.dumps(marker), encoding="utf-8")
        os.replace(temporary, self.marker_path)

    def _set_phase(self, phase: str, done: int | None = None, total: int | None = None) -> None:
        with self._lock:
            self._progress.phase = phase
            self._progress.current = 0
            if done is not None:
                self._progress.done = done
            if total is not None:
                self._progress.total = total

    def _set_current(self, value: int) -> None:
        with self._lock:
            self._progress.current = value

    def _check_cancel(self) -> None:
        if self._cancel.is_set():
            raise _Cancelled()

    def _settings_engine_url(self) -> str | None:
        try:
            value = json.loads((self.root / SETTINGS_FILE).read_text(encoding="utf-8")).get("engineBaseUrl")
        except (OSError, ValueError, AttributeError):
            return None
        return value if isinstance(value, str) and value.startswith("https://") else None  # a file on disk must not pick plain http

    def _engine_candidates(self) -> list[str]:
        override = self.engine_url or os.environ.get(ENV_ENGINE_URL) or self._settings_engine_url()
        return engine_base_urls(self.version, override)

    def _download_engine(self) -> None:
        asset = engine_asset(self.key)
        target = self._engine_target()
        last_error = "The voice engine could not be downloaded."
        for base in self._engine_candidates():
            self._check_cancel()
            try:
                expected = self._fetch_text(f"{base}/{asset}.sha256").split()[0].lower()
                size = self._download(f"{base}/{asset}", target, None, phase_total=True)
            except _NotFound:
                last_error = "This version of Personal Note has no voice engine for this system yet."
                continue
            except VoiceError as error:
                last_error = str(error)
                continue
            digest = _sha256(target)
            if digest != expected:
                target.unlink(missing_ok=True)
                raise VoiceError("The downloaded voice engine failed its checksum check. Nothing was installed; try again.")
            self._unpack_engine(target)
            target.unlink(missing_ok=True)
            try:
                target.parent.rmdir()  # the empty downloads folder
            except OSError:
                pass
            self._set_phase("model", done=size, total=size + self.model_bytes)
            return
        raise VoiceError(last_error)

    def _download_model(self) -> None:
        url = os.environ.get(ENV_MODEL_URL) or self.model_url
        self.model_path.parent.mkdir(parents=True, exist_ok=True)
        if self.model_path.is_file():
            # A finished model from an earlier install: use it if it checks out, else replace it.
            self._set_phase("verifying")
            if self.model_path.stat().st_size == self.model_bytes and _sha256(self.model_path) == self.model_sha256:
                return
            self.model_path.unlink()
            self._set_phase("model")
        self._download(url, self.model_path, self.model_bytes)
        self._set_phase("verifying", done=self._progress.total, total=self._progress.total)
        size = self.model_path.stat().st_size
        if size != self.model_bytes or _sha256(self.model_path) != self.model_sha256:
            self.model_path.unlink(missing_ok=True)
            raise VoiceError("The downloaded voice model failed its size and checksum check. Nothing was installed; try again.")

    def _unpack_engine(self, archive: Path) -> None:
        staging = self.root / "engine.new"
        shutil.rmtree(staging, ignore_errors=True)
        staging.mkdir(parents=True)
        try:
            with tarfile.open(archive, "r:gz") as bundle:
                for member in bundle.getmembers():
                    destination = (staging / member.name).resolve()
                    if staging.resolve() not in destination.parents and destination != staging.resolve():
                        raise VoiceError("The voice engine archive is not safe to unpack.")
                    if not (member.isfile() or member.isdir()):  # no links of any kind
                        raise VoiceError("The voice engine archive is not safe to unpack.")
                bundle.extractall(staging, filter="data") if hasattr(tarfile, "data_filter") else bundle.extractall(staging)
        except (tarfile.TarError, OSError) as error:
            shutil.rmtree(staging, ignore_errors=True)
            raise VoiceError("The voice engine archive could not be unpacked. Try again.") from error
        except VoiceError:
            shutil.rmtree(staging, ignore_errors=True)
            raise
        binary = staging / "bin" / ENGINE_BINARY
        if not binary.is_file():
            shutil.rmtree(staging, ignore_errors=True)
            raise VoiceError("The voice engine archive does not contain the engine.")
        binary.chmod(binary.stat().st_mode | 0o111)
        shutil.rmtree(self.engine_dir, ignore_errors=True)
        os.replace(staging, self.engine_dir)

    # ---- http ----------------------------------------------------------------------------

    def _request(self, url: str, headers: dict | None = None):
        request = Request(url, headers={"User-Agent": USER_AGENT, **(headers or {})})
        try:
            return self.opener(request, timeout=30)
        except HTTPError as error:
            error.close()
            if error.code == 404:
                raise _NotFound(url) from error
            if error.code == 416:
                raise
            raise VoiceError(f"The download server answered {error.code}. Try again later.") from error
        except (URLError, OSError, TimeoutError) as error:
            raise VoiceError("Could not reach the download server. Check your connection and try again.") from error

    def _fetch_text(self, url: str) -> str:
        with self._request(url) as response:
            return response.read(4096).decode("utf-8", "replace").strip()

    def _download(self, url: str, target: Path, expected: int | None, phase_total: bool = False) -> int:
        """Download to `<target>.part` (resuming), then move it to `target`. Returns the final size."""
        target.parent.mkdir(parents=True, exist_ok=True)
        part = self._part(target)
        have = part.stat().st_size if part.exists() else 0
        if expected is not None and have > expected:
            part.unlink()
            have = 0
        if expected is not None and have == expected:
            os.replace(part, target)
            return expected
        headers = {"Range": f"bytes={have}-"} if have else {}
        try:
            response = self._request(url, headers)
        except HTTPError as error:  # 416: the partial file is not a prefix we can extend
            part.unlink(missing_ok=True)
            have = 0
            if error.code != 416:
                raise
            response = self._request(url)
        with response:
            status = getattr(response, "status", 200)
            if status != 206 and have:
                have = 0  # the server ignored the range: start over
            length = int(response.headers.get("Content-Length") or 0)
            total = have + length if length else (expected or 0)
            if phase_total:
                with self._lock:
                    self._progress.total = total + self.model_bytes
            with open(part, "ab" if have else "wb") as handle:
                written = have
                while True:
                    self._check_cancel()
                    try:
                        block = response.read(CHUNK)
                    except (OSError, TimeoutError) as error:
                        raise VoiceError("The download was interrupted. Try again to resume it.") from error
                    if not block:
                        break
                    handle.write(block)
                    written += len(block)
                    self._set_current(written)
        if total and written != total:
            raise VoiceError("The download was interrupted. Try again to resume it.")
        os.replace(part, target)
        return written

    # ---- remove --------------------------------------------------------------------------

    def remove(self) -> dict:
        """Stop the engine and delete everything voice downloaded. Notes are never touched."""
        self.cancel_install()
        self.stop_engine()
        shutil.rmtree(self.root, ignore_errors=True)
        with self._lock:
            self._progress = _Progress()
        return self.status()

    # ---- engine process ------------------------------------------------------------------
    #
    # One supervisor thread per engine run starts the process and waits for it for as long as it lives. That thread
    # is also what PR_SET_PDEATHSIG is tied to (Linux delivers the signal when the *thread* that started the child
    # ends), so no short-lived request thread may start it. Locks: `_start_lock` serialises start attempts and is
    # held while waiting for the port; `_lock` guards state only and is never held while waiting, so status() and
    # stop_engine() stay responsive during startup.

    def _running(self) -> bool:
        process = self._process
        return process is not None and process.poll() is None and self._port is not None and self._ready

    def _choose_port(self) -> int:
        for candidate in (self.preferred_port, 0):
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
                try:
                    probe.bind((HOST, candidate))
                except OSError:
                    continue
                return probe.getsockname()[1]
        raise VoiceError("No free local port is available for voice.")

    def _command(self, port: int) -> list[str]:
        return [
            str(self.binary_path()), "serve", "--asr-model", str(self.model_path),
            "--device", "cpu" if self.key != "macos-arm64" else "auto",
            "--host", HOST, "--port", str(port), "--no-ui",
        ]

    def _open_log(self):
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        if self.log_path.exists() and self.log_path.stat().st_size > LOG_LIMIT:
            self.log_path.replace(self.log_path.with_name("engine.log.1"))
        return open(self.log_path, "ab")

    @property
    def pid_path(self) -> Path:
        return self.root / "engine.pid"

    def _reap_stale_engine(self) -> None:
        """Kill an engine an earlier run left behind (the pid file says which); never any other process."""
        try:
            record = json.loads(self.pid_path.read_text(encoding="utf-8"))
            pid, binary = int(record["pid"]), str(record["binary"])
        except (OSError, ValueError, KeyError, TypeError):
            self.pid_path.unlink(missing_ok=True)
            return
        try:
            command = subprocess.run(["ps", "-ww", "-p", str(pid), "-o", "args="], capture_output=True, text=True, timeout=5).stdout
        except (OSError, subprocess.SubprocessError):
            command = ""
        if binary in command:  # the same pid could now belong to something else
            for sig in (signal.SIGTERM, signal.SIGKILL):
                try:
                    os.kill(pid, sig)
                except OSError:
                    break
                deadline = time.monotonic() + 3
                while time.monotonic() < deadline and _alive(pid):
                    time.sleep(0.05)
                if not _alive(pid):
                    break
        self.pid_path.unlink(missing_ok=True)

    def _popen(self, port: int) -> subprocess.Popen:
        with self._lock:
            if self._log is not None:
                self._log.close()
            self._log = self._open_log()
            log = self._log
        try:
            process = subprocess.Popen(
                self._command(port), cwd=self.binary_path().parent, env=child_env(),
                stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                preexec_fn=(lambda parent=os.getpid(): _die_with_parent(parent)) if _PRCTL else None,
            )
        except OSError as error:
            raise VoiceError("The voice engine could not be started. Remove voice and download it again.") from error
        try:
            self.pid_path.write_text(json.dumps({"pid": process.pid, "binary": str(self.binary_path())}), encoding="utf-8")
        except OSError:
            pass
        return process

    def start_engine(self) -> dict:
        """Start the engine (if installed and not running) and wait until it accepts connections."""
        with self._start_lock:
            if not self._running():
                if self.key is None or not self.installed():
                    raise VoiceError("Voice is not installed. Open Settings, then Voice, and download it.")
                self._reap_stale_engine()
                with self._lock:
                    self._stopping = False
                    self._restarts = 0
                    self._engine_error = ""
                port = self._choose_port()
                spawned = threading.Event()
                outcome: dict = {}
                supervisor = threading.Thread(
                    target=self._supervise, args=(port, spawned, outcome), name="personal-note-voice-engine", daemon=True
                )
                supervisor.start()
                spawned.wait()
                if "error" in outcome:
                    self._record_engine_error(outcome["error"])
                    raise outcome["error"]
                process = outcome["process"]
                try:
                    self._await_ready(process, port)
                except VoiceError as error:
                    with self._lock:
                        if self._process is process:
                            self._process = self._port = None
                            self._ready = False
                    self._terminate(process)
                    self._record_engine_error(error)
                    raise
        return self.status()

    def _record_engine_error(self, error: Exception) -> None:
        with self._lock:
            self._engine_error = str(error)

    def _supervise(self, port: int, spawned: threading.Event, outcome: dict) -> None:
        try:
            process = self._popen(port)
        except VoiceError as error:
            outcome["error"] = error
            spawned.set()
            return
        with self._lock:
            self._process, self._port, self._ready = process, port, False
        outcome["process"] = process
        spawned.set()
        while True:
            process.wait()
            with self._lock:
                if self._stopping or self._process is not process:
                    return
                self._process = self._port = None
                self._ready = False
                if process.returncode == -signal.SIGILL:
                    self._engine_error = UNSUPPORTED_CPU  # restarting cannot help
                    return
                if self._restarts >= 1:
                    logger.warning("Voice engine stopped again; not restarting it.")
                    return
                self._restarts += 1
            logger.warning("Voice engine stopped unexpectedly; restarting it once.")
            try:
                port = self._choose_port()
                process = self._popen(port)
            except VoiceError as error:
                self._record_engine_error(error)
                return
            with self._lock:
                self._process, self._port, self._ready = process, port, False
            try:
                self._await_ready(process, port)
            except VoiceError as error:
                self._terminate(process)
                with self._lock:
                    if self._process is process:
                        self._process = self._port = None
                self._record_engine_error(error)
                return

    def _await_ready(self, process: subprocess.Popen, port: int) -> None:
        deadline = time.monotonic() + self.ready_timeout
        while time.monotonic() < deadline:
            code = process.poll()
            if code is not None:
                if code == -signal.SIGILL:
                    raise VoiceError(UNSUPPORTED_CPU)
                raise VoiceError("The voice engine stopped while starting. Its log is in the voice folder.")
            try:
                socket.create_connection((HOST, port), timeout=0.3).close()
            except OSError:
                time.sleep(0.05)
                continue
            with self._lock:
                if self._process is process:
                    self._ready = True
            return
        raise VoiceError("The voice engine did not become ready in time.")

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
            self._stopping = True
            process, self._process, self._port, self._ready = self._process, None, None, False
            log, self._log = self._log, None
        if process is not None:
            self._terminate(process)
        if log is not None:
            log.close()
        self.pid_path.unlink(missing_ok=True)

    def autostart(self) -> None:
        """Start the engine in the background when voice is installed (desktop launch). Never raises."""

        def run():
            try:
                if self.key and self.installed():
                    self.start_engine()
            except VoiceError as error:
                logger.warning("Voice engine did not start: %s", error)
            except Exception:
                logger.exception("Voice engine did not start")

        threading.Thread(target=run, name="personal-note-voice-autostart", daemon=True).start()

    shutdown = stop_engine


class _Cancelled(Exception):
    pass


class _NotFound(VoiceError):
    pass


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while block := handle.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        return True
    return True


def _load_prctl():
    """Resolved once at import (Linux only), so the code that runs between fork and exec only calls it."""
    if not sys.platform.startswith("linux"):
        return None
    try:
        import ctypes

        return ctypes.CDLL("libc.so.6", use_errno=True).prctl
    except (OSError, AttributeError):
        return None


_PRCTL = _load_prctl()


def _die_with_parent(parent: int) -> None:
    """Runs in the child: have the kernel stop the engine if this app dies (PR_SET_PDEATHSIG)."""
    _PRCTL(1, signal.SIGTERM)
    if os.getppid() != parent:  # the app died before the signal was armed
        os._exit(1)
