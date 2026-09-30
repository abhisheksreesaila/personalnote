"""Personal Note desktop app: the local server inside a native window.

Runs the same FastHTML app as `main.py`, in-process on a free loopback port, and
shows it in a pywebview window. Closing the window flushes pending edits and stops
the server. Start it with `npm run desktop` or `python desktop.py`.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Callable
from urllib.error import URLError
from urllib.request import Request, urlopen

PROCESS_START = time.perf_counter()

from app_paths import default_database_path  # noqa: E402

HOST = "127.0.0.1"
WINDOW_TITLE = "Personal Note"
WINDOW_SIZE = (1280, 860)
WINDOW_MIN_SIZE = (900, 600)
FOCUS_PATH = "/_desktop/focus"
ROOT = Path(__file__).resolve().parent
FRONTEND_INPUTS = ("src", "public", "index.html", "landing-note.html", "spatial-docs.html", "vite.config.js", "package.json")

logger = logging.getLogger("personal-note.desktop")


class DesktopError(Exception):
    """Expected start-up problem, shown to the user as one line."""


# ---- frontend build -------------------------------------------------------------------------


def _newest_mtime(path: Path) -> float:
    if path.is_file():
        return path.stat().st_mtime
    if not path.is_dir():
        return 0.0
    return max((p.stat().st_mtime for p in path.rglob("*") if p.is_file()), default=0.0)


def frontend_is_stale(root: Path = ROOT) -> bool:
    built = root / "dist" / "index.html"
    if not built.is_file():
        return True
    newest_source = max((_newest_mtime(root / name) for name in FRONTEND_INPUTS), default=0.0)
    return newest_source > built.stat().st_mtime


def ensure_frontend_built(root: Path = ROOT, run: Callable = subprocess.run) -> None:
    if not frontend_is_stale(root):
        return
    has_dist = (root / "dist" / "index.html").is_file()
    npm = shutil.which("npm")
    if npm is None or not (root / "package.json").is_file():
        if has_dist:
            logger.warning("Frontend sources changed but npm is unavailable; using the existing build.")
            return
        raise DesktopError("The frontend is not built. Run `npm install && npm run build` first.")
    if not (root / "node_modules").is_dir():
        run([npm, "install"], cwd=root, check=True)
    print("Building the frontend...", flush=True)
    try:
        run([npm, "run", "build"], cwd=root, check=True)
    except subprocess.CalledProcessError as error:
        raise DesktopError("The frontend build failed; see the output above.") from error


# ---- server ---------------------------------------------------------------------------------


class LocalServer:
    """Runs the ASGI app with uvicorn in a background thread on a free loopback port."""

    def __init__(self, app, host: str = HOST, on_focus: Callable[[], None] | None = None):
        self.app = app
        self.host = host
        self.on_focus = on_focus
        self.base_url: str | None = None
        self._server = None
        self._thread: threading.Thread | None = None
        self._sock: socket.socket | None = None
        self._install_focus_route()

    def _install_focus_route(self) -> None:
        from starlette.responses import JSONResponse

        @self.app.route(FOCUS_PATH, methods=["POST"])
        def focus():
            if self.on_focus:
                threading.Thread(target=self.on_focus, daemon=True).start()
            return JSONResponse({"ok": True})


    def start(self, timeout: float = 15.0) -> str:
        import uvicorn

        # Bind here, then hand the socket to uvicorn, so the port cannot be taken in between.
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._sock.bind((self.host, 0))
        port = self._sock.getsockname()[1]
        config = uvicorn.Config(self.app, log_level=os.getenv("LOG_LEVEL", "warning").lower(), lifespan="off")
        self._server = uvicorn.Server(config)
        self._thread = threading.Thread(
            target=self._server.run, kwargs={"sockets": [self._sock]}, name="personal-note-server", daemon=True
        )
        self._thread.start()
        deadline = time.monotonic() + timeout
        while not self._server.started:
            if not self._thread.is_alive() or time.monotonic() > deadline:
                raise DesktopError("The local server did not start.")
            time.sleep(0.005)
        self.base_url = f"http://{self.host}:{port}"
        return self.base_url

    def stop(self, timeout: float = 5.0) -> None:
        if self._server is not None:
            self._server.should_exit = True
        if self._thread is not None:
            self._thread.join(timeout)
        if self._sock is not None:
            self._sock.close()
        self._server = self._thread = self._sock = None


# ---- single instance ------------------------------------------------------------------------


def instance_file(database: Path) -> Path:
    return database.with_name(database.name + ".desktop.json")


def record_instance(database: Path, base_url: str) -> None:
    path = instance_file(database)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"url": base_url, "pid": os.getpid()}), encoding="utf-8")


def clear_instance(database: Path) -> None:
    try:
        instance_file(database).unlink()
    except FileNotFoundError:
        pass


def focus_running_instance(database: Path) -> str | None:
    """If a desktop app already owns this database, ask it to come forward and return its URL."""
    try:
        url = json.loads(instance_file(database).read_text(encoding="utf-8"))["url"]
        request = Request(url + FOCUS_PATH, method="POST")
        with urlopen(request, timeout=1.5) as response:
            return url if json.load(response).get("ok") else None
    except (OSError, URLError, ValueError, KeyError, TypeError):
        return None


# ---- window ---------------------------------------------------------------------------------


def allow_microphone(window) -> None:
    """Let the page ask for the microphone where the webview needs to be told it may.

    WebKitGTK (Linux) denies media requests unless the app answers them. On macOS WKWebView
    shows the system prompt itself, and the bundle's NSMicrophoneUsageDescription backs it.
    A failure here leaves the app's own "voice unavailable" message to explain it.
    """
    if not sys.platform.startswith("linux"):
        return
    try:
        import gi

        gi.require_version("WebKit2", "4.1")
        from gi.repository import GLib, WebKit2

        def answer(_view, request):
            if isinstance(request, WebKit2.UserMediaPermissionRequest):
                if request.props.is_for_video_device:
                    request.deny()
                else:
                    request.allow()
                return True
            return False

        from webview.platforms.gtk import BrowserView

        def attach():
            BrowserView.instances[window.uid].webview.connect("permission-request", answer)
            return False

        GLib.idle_add(attach)
    except Exception:
        logger.warning("Could not enable microphone access in this window.", exc_info=True)


def run_window(base_url: str, database: Path, server: LocalServer, timing: bool) -> None:
    if sys.platform.startswith("linux"):
        # WebKitGTK's DMABUF renderer crashes some Wayland sessions with a protocol error.
        os.environ.setdefault("WEBKIT_DISABLE_DMABUF_RENDERER", "1")
    import webview

    webview.settings["ALLOW_DOWNLOADS"] = True  # backup and Markdown export are downloads
    window = webview.create_window(
        WINDOW_TITLE,
        base_url + "/notes",
        width=WINDOW_SIZE[0],
        height=WINDOW_SIZE[1],
        min_size=WINDOW_MIN_SIZE,
        text_select=True,
    )
    server.on_focus = lambda: (window.restore(), window.show())

    flushed = threading.Event()

    def flush_then_close():
        # Same path the page takes on pagehide, run while the server is still up.
        try:
            window.evaluate_js("window.dispatchEvent(new Event('pagehide'))")
            time.sleep(0.4)
        except Exception:
            logger.warning("Could not flush pending edits before closing.", exc_info=True)
        flushed.set()
        window.destroy()

    def on_closing():
        # The handler runs on the GUI thread, so the flush runs elsewhere; close again once it is done.
        if flushed.is_set():
            return True
        threading.Thread(target=flush_then_close, daemon=True).start()
        return False

    window.events.closing += on_closing

    def on_started():
        allow_microphone(window)
        if timing:
            report_timing(window)

    webview.start(on_started)


def report_timing(window) -> None:
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            if window.evaluate_js("document.querySelector('canvas') ? 1 : 0"):
                print(f"[timing] canvas usable {time.perf_counter() - PROCESS_START:.2f}s after process start", flush=True)
                return
        except Exception:
            pass
        time.sleep(0.02)
    print("[timing] canvas did not appear within 30s", flush=True)


# ---- entry point ----------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="personal-note-desktop", description="Open Personal Note in its own window.")
    parser.add_argument("--no-build", action="store_true", help="Do not rebuild the frontend even if it looks stale")
    parser.add_argument("--timing", action="store_true", help="Print cold-start timings")
    args = parser.parse_args(argv)
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "WARNING"), format="%(asctime)s %(levelname)s %(name)s %(message)s")

    database = default_database_path()
    try:
        running = focus_running_instance(database)
        if running:
            print(f"Personal Note is already open ({running}); brought it forward.")
            return 0
        if not args.no_build and not getattr(sys, "frozen", False):
            ensure_frontend_built()
        from routes import create_app

        server = LocalServer(create_app(database))
        base_url = server.start()
    except DesktopError as error:
        print(error, file=sys.stderr)
        return 1
    if args.timing:
        print(f"[timing] server ready {time.perf_counter() - PROCESS_START:.2f}s after process start", flush=True)
    record_instance(database, base_url)
    try:
        run_window(base_url, database, server, args.timing)
    except ImportError as error:
        print(
            f"The desktop window needs pywebview and a system web view ({error}).\n"
            "Install them with: pip install -r requirements-desktop.txt (see README, Desktop app).",
            file=sys.stderr,
        )
        return 1
    finally:
        clear_instance(database)
        server.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
