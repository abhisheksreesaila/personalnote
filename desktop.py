"""Personal Note desktop app: the local server inside a native window.

Runs the same FastHTML app as `main.py`, in-process on a free loopback port, and
shows it in a Chromium app window (Linux, when installed) or a pywebview window.
Closing the window flushes pending edits and stops the server, and the voice engine if it was started. Start it with `npm run desktop` or `python desktop.py`.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import shutil
import secrets
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

from app_paths import app_data_dir, default_database_path, instance_file, resource_root  # noqa: E402
import desktop_menu  # noqa: E402
from chromium_app import child_env, find_chromium, focus_window, profile_owner_pid, run_chromium_window  # noqa: E402

HOST = "127.0.0.1"
# A fixed preferred port keeps the page's origin stable, so localStorage (skin, speed meter, preferences)
# and the microphone permission survive restarts. Another port is used only when this one is taken.
PREFERRED_PORT = 3138
WINDOW_TITLE = "Personal Note"
WINDOW_SIZE = (1280, 860)
WINDOW_MIN_SIZE = (900, 600)
FLUSH_TIMEOUT = 3.0
FOCUS_PATH = "/_desktop/focus"
NONCE_HEADER = "x-focus-nonce"
ROOT = resource_root()
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

    def __init__(self, app, host: str = HOST, on_focus: Callable[[], None] | None = None, preferred_port: int = 0):
        self.app = app
        self.host = host
        self.preferred_port = preferred_port
        self.on_focus = on_focus
        self.nonce = secrets.token_hex(16)
        self.base_url: str | None = None
        self._server = None
        self._thread: threading.Thread | None = None
        self._sock: socket.socket | None = None
        self.fell_back = False
        self._install_focus_route()

    def _install_focus_route(self) -> None:
        from starlette.responses import JSONResponse

        @self.app.route(FOCUS_PATH, methods=["POST"])
        def focus(request):
            # Only the desktop app that wrote the instance record knows the nonce.
            if not secrets.compare_digest(request.headers.get(NONCE_HEADER, ""), self.nonce):
                return JSONResponse({"ok": False}, status_code=403)
            if self.on_focus:
                threading.Thread(target=self.on_focus, daemon=True).start()
            return JSONResponse({"ok": True})


    def start(self, timeout: float = 15.0) -> str:
        import uvicorn

        # Bind here, then hand the socket to uvicorn, so the port cannot be taken in between.
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            self._sock.bind((self.host, self.preferred_port))
        except OSError:
            self._sock.bind((self.host, 0))  # the preferred port is taken by something else
            self.fell_back = True
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


def record_instance(database: Path, base_url: str, nonce: str) -> None:
    path = instance_file(database)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.unlink(missing_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)  # private from the first byte
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(json.dumps({"url": base_url, "pid": os.getpid(), "nonce": nonce}))


def clear_instance(database: Path) -> None:
    try:
        instance_file(database).unlink()
    except FileNotFoundError:
        pass


def focus_running_instance(database: Path) -> str | None:
    """If a desktop app already owns this database, ask it to come forward and return its URL."""
    try:
        record = json.loads(instance_file(database).read_text(encoding="utf-8"))
        url = record["url"]
        request = Request(url + FOCUS_PATH, method="POST", headers={NONCE_HEADER: record["nonce"]})
        with urlopen(request, timeout=1.5) as response:
            return url if json.load(response).get("ok") else None
    except (OSError, URLError, ValueError, KeyError, TypeError):
        return None


# ---- window ---------------------------------------------------------------------------------


def allow_microphone(window) -> None:
    """Let the page ask for the microphone where the webview needs to be told it may.

    WebKitGTK (Linux) denies media requests unless the app answers them. On macOS WKWebView
    shows the system prompt itself (pywebview 6.2.1 implements no media-capture permission hook, so
    WebKit's default prompt applies, and only audio is ever requested), and the bundle's
    NSMicrophoneUsageDescription backs it. Not verified on a Mac.
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


def flush_page(window, timeout: float = FLUSH_TIMEOUT) -> bool:
    """Ask the page to send pending edits and wait (bounded) until they are saved. True if nothing is left."""
    try:
        window.evaluate_js(
            "window.__flushResult = null;"
            "Promise.resolve(window.personalNote ? window.personalNote.flush() : true)"
            ".then((ok) => { window.__flushResult = ok ? 1 : 0 }, () => { window.__flushResult = 0 }); 0"
        )
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            result = window.evaluate_js("window.__flushResult")
            if result is not None:
                return bool(result)
            time.sleep(0.03)
    except Exception:
        logger.warning("Could not flush pending edits.", exc_info=True)
    return False


EMPTY_NOTICE = (
    "This is a new, empty notebook. Notes from a source checkout stay in its data/ folder: "
    "run `bin/personal-note migrate-data` in that checkout to bring them here."
)


def empty_notebook_notice(database: Path) -> str | None:
    """A one-line notice when this database holds no notes the user has written."""
    from services import NoteService

    if not database.exists():
        return EMPTY_NOTICE
    notes = NoteService(database).list_notes()
    untouched = len(notes) == 1 and notes[0]["title"] == "Untitled note" and notes[0]["revision"] <= 1
    return EMPTY_NOTICE if not notes or untouched else None


def show_notice(window, message: str) -> None:
    script = (
        "(() => { const bar = document.createElement('div'); bar.setAttribute('role', 'status');"
        "bar.style.cssText = 'position:fixed;left:50%;bottom:72px;transform:translateX(-50%);z-index:99999;"
        "max-width:min(640px,90vw);padding:10px 14px;border-radius:var(--radius-panel);background:var(--surface);"
        "color:var(--ink);border:1px solid var(--line);font:13px var(--ui-font);box-shadow:var(--shadow-panel);cursor:pointer';"
        f"bar.textContent = {json.dumps(message)}; bar.title = 'Click to dismiss'; bar.onclick = () => bar.remove();"
        "document.body.appendChild(bar); setTimeout(() => bar.remove(), 20000); })()"
    )
    window.evaluate_js(script)


def window_url(base_url: str, platform: str = sys.platform) -> str:
    # window.pywebview is injected after page load; the flags let the page know it is the desktop app at once
    # and, on macOS, that its content runs under a transparent title bar (desktop_menu.py).
    return desktop_menu.window_url(base_url, platform)


class DesktopApi:
    """The only Python the page can call (macOS window only): double-clicking the top bar zooms the window."""

    def __init__(self, zoom: Callable[[], None]):
        self._zoom = zoom

    def zoom_window(self) -> bool:
        try:
            self._zoom()
            return True
        except Exception:
            logger.warning("Could not zoom the window.", exc_info=True)
            return False


def _page_call(window, call: str) -> None:
    try:
        window.evaluate_js(f"window.personalNote && window.personalNote.{call}")
    except Exception:
        logger.warning("Could not tell the page about the window state.", exc_info=True)


def setup_mac_window(window, actions: "desktop_menu.MenuActions", menus=None) -> None:
    """Unified title bar, menu bar and full-screen sync for the macOS window. Never raises. Unverified on a Mac."""

    def apply():
        try:
            native = window.native
            if native is None:
                raise RuntimeError("the native window is not available yet")
            desktop_menu.style_unified_title_bar(native)
        except Exception:
            logger.warning("Could not extend the page under the title bar; using the standard title bar.", exc_info=True)
            threading.Thread(target=_page_call, args=(window, "setMacChrome(false)"), daemon=True).start()
        if menus is not None:
            desktop_menu.install_menu_guard(getattr(window, "native", None), actions, menus)
        desktop_menu.install_native_menu(actions)

    def sync_full_screen():
        native = getattr(window, "native", None)
        if native is None:
            return
        full = desktop_menu.on_main_thread(lambda: desktop_menu.is_full_screen(native))
        if full is not None:
            _page_call(window, f"setFullscreen({'true' if full else 'false'})")

    def after_show():
        try:
            from PyObjCTools import AppHelper

            AppHelper.callAfter(apply)  # runs once the app loop has built the menu bar
        except Exception:
            logger.warning("Could not set up the macOS window chrome.", exc_info=True)

    window.events.shown += after_show
    window.events.maximized += sync_full_screen  # pywebview reports entering native full screen as "maximized"
    window.events.restored += sync_full_screen


def run_window(base_url: str, database: Path, server: LocalServer, timing: bool) -> None:
    if sys.platform.startswith("linux"):
        # WebKitGTK's DMABUF renderer crashes some Wayland sessions with a protocol error.
        os.environ.setdefault("WEBKIT_DISABLE_DMABUF_RENDERER", "1")
    import webview

    webview.settings["ALLOW_DOWNLOADS"] = True  # backup and Markdown export are downloads
    mac = sys.platform == "darwin"
    mac_zoom: list[Callable[[], None]] = []  # filled once the window exists; the page's js_api needs the window first
    window_options = {"js_api": DesktopApi(lambda: mac_zoom[0]())} if mac else {}
    window = webview.create_window(
        WINDOW_TITLE,
        window_url(base_url),
        width=WINDOW_SIZE[0],
        height=WINDOW_SIZE[1],
        min_size=WINDOW_MIN_SIZE,
        text_select=True,
        **window_options,
    )
    menus = None
    if mac:
        try:
            from webview.menu import Menu, MenuAction, MenuSeparator

            mac_zoom.append(lambda: desktop_menu.on_main_thread(lambda: desktop_menu.zoom_native_window(window.native)))
            actions = desktop_menu.MenuActions(window, mac_zoom[0])
            menus = desktop_menu.webview_menus(actions, Menu, MenuAction, MenuSeparator)
            setup_mac_window(window, actions, menus)
        except Exception:
            logger.warning("Could not set up the macOS menu bar; the default menus stay.", exc_info=True)
    server.on_focus = lambda: (window.restore(), window.show())

    flushed = threading.Event()

    def flush_then_close():
        if not flush_page(window):
            logger.warning("Pending edits may not have been saved before closing.")
        flushed.set()
        window.destroy()

    def on_closing():
        # The handler runs on the GUI thread, so the flush runs elsewhere; close again once it is done.
        if flushed.is_set():
            return True
        threading.Thread(target=flush_then_close, daemon=True).start()
        return False

    window.events.closing += on_closing

    notice = empty_notebook_notice(database) if getattr(sys, "frozen", False) else None
    notice = " ".join(part for part in (notice, getattr(server, "fallback_notice", None)) if part) or None
    if notice:
        window.events.loaded += lambda: show_notice(window, notice)

    def on_started():
        allow_microphone(window)
        if timing:
            report_timing(window)

    # A persistent web context: the page keeps localStorage (display preferences) between runs.
    storage = app_data_dir() / "webview"
    storage.mkdir(parents=True, exist_ok=True)
    start_options = {"menu": menus} if menus else {}
    webview.start(on_started, private_mode=False, storage_path=str(storage), **start_options)


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


# ---- engine ---------------------------------------------------------------------------------


def choose_engine(requested: str, platform: str = sys.platform, which: Callable = shutil.which) -> tuple[str, str | None]:
    """Pick the window engine: ("chromium", binary) or ("webview", None).

    `auto` uses a Chromium app window on Linux when a Chromium/Chrome binary exists, and the
    pywebview window everywhere else (macOS and Windows keep it for now).
    """
    if requested == "webview":
        return "webview", None
    binary = find_chromium(which)
    if requested == "chromium":
        if binary is None:
            raise DesktopError("No Chromium or Chrome found (tried chromium, chromium-browser, google-chrome-stable, google-chrome).")
        return "chromium", binary
    if platform.startswith("linux") and binary:
        return "chromium", binary
    return "webview", None


MISSING_CHROMIUM = (
    "Personal Note opens in Chromium or Google Chrome, and neither was found. "
    "Install one (for example: sudo apt install chromium) and start Personal Note again."
)


def report_startup_error(message: str, which: Callable = shutil.which, run: Callable = subprocess.run) -> str | None:
    """Show a start-up problem where a user launching from the menu will see it, and on stderr.

    Tries a notification, then a dialog. Returns the tool used, or None when only stderr was possible.
    """
    print(message, file=sys.stderr)
    tools = (
        ("notify-send", ["-u", "critical", "Personal Note", message]),
        ("zenity", ["--error", "--title=Personal Note", f"--text={message}"]),
        ("kdialog", ["--error", message, "--title", "Personal Note"]),
    )
    for name, args in tools:
        binary = which(name)
        if not binary:
            continue
        try:
            run([binary, *args], timeout=30, env=child_env())
            return name
        except (OSError, subprocess.SubprocessError):
            continue
    return None


def check_profile_free(profile: Path) -> None:
    """Refuse to start when a Chromium already holds the app profile but no server answered.

    Starting a second server would put the open window on a dead origin while a new one saves to the
    same database, so bring the window forward and stop with a clear message instead.
    """
    pid = profile_owner_pid(profile)
    if pid is None:
        return
    focus_window(pid)
    raise DesktopError(
        "A Personal Note window is already open but its server is not answering. "
        "Close that window (it may be saving), then start Personal Note again."
    )


def wait_for_stop(base_url: str) -> None:
    """Headless mode: print the address, then block until SIGINT or SIGTERM."""
    import signal

    stop = threading.Event()
    for name in ("SIGINT", "SIGTERM"):
        signal.signal(getattr(signal, name), lambda *_: stop.set())
    print(f"Serving on {base_url}", flush=True)
    stop.wait()


# ---- entry point ----------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="personal-note-desktop", description="Open Personal Note in its own window.")
    parser.add_argument("--no-build", action="store_true", help="Do not rebuild the frontend even if it looks stale")
    parser.add_argument(
        "--engine", choices=("auto", "chromium", "webview"), default="auto",
        help="Window engine: a Chromium app window (default on Linux when installed) or the pywebview window",
    )
    parser.add_argument("--timing", action="store_true", help="Print cold-start timings")
    parser.add_argument("--serve", action="store_true", help="Run only the local server, with no window, until interrupted")
    parser.add_argument("--port", type=int, default=None, help="Port for --serve (default: any free port)")
    args = parser.parse_args(argv)
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "WARNING"), format="%(asctime)s %(levelname)s %(name)s %(message)s")

    database = default_database_path()
    try:
        running = focus_running_instance(database)
        if running:
            print(f"Personal Note is already open ({running}); brought it forward.")
            return 0
        engine, chromium = ("serve", None) if args.serve else choose_engine(args.engine)
        if getattr(sys, "frozen", False) and sys.platform.startswith("linux") and engine == "webview":
            report_startup_error(MISSING_CHROMIUM)  # the Linux bundle has no pywebview to fall back to
            return 1
        if engine == "chromium":
            check_profile_free(app_data_dir() / "chromium-profile")
        if not args.no_build and not getattr(sys, "frozen", False):
            ensure_frontend_built()
        from routes import create_app

        app = create_app(database, bound_host=HOST)
        server = LocalServer(app, preferred_port=(args.port or 0) if args.serve else PREFERRED_PORT)
        base_url = server.start()
    except DesktopError as error:
        print(error, file=sys.stderr)
        return 1
    fallback_notice = None
    if server.fell_back and PREFERRED_PORT and not args.serve:
        fallback_notice = (
            f"Port {PREFERRED_PORT} is in use by another program, so Personal Note is using a different port. "
            "Saved preferences (skin, speed meter) and the microphone permission start fresh on this port."
        )
        print(f"Warning: {fallback_notice}", file=sys.stderr)
    server.fallback_notice = fallback_notice
    if args.timing:
        print(f"[timing] server ready {time.perf_counter() - PROCESS_START:.2f}s after process start", flush=True)
    record_instance(database, base_url, server.nonce)
    app.state.voice.autostart()  # when voice is installed, its engine starts with the window (in the background)
    try:
        if engine == "serve":
            wait_for_stop(base_url)
        elif engine == "chromium":
            code = run_chromium_window(base_url, chromium, app_data_dir() / "chromium-profile", server)
            if code != 0:
                print(f"The Chromium window exited with an error (code {code}). Try `--engine webview`.", file=sys.stderr)
                return 1
        else:
            run_window(base_url, database, server, args.timing)
    except OSError as error:
        if engine != "chromium":
            raise
        print(f"Could not start the Chromium window ({error}). Try `--engine webview`.", file=sys.stderr)
        return 1
    except ImportError as error:
        if getattr(sys, "frozen", False):
            print(f"Personal Note could not open its window ({error}).", file=sys.stderr)
        else:
            print(
                f"The desktop window needs pywebview and a system web view ({error}).\n"
                "Install them with: pip install -r requirements-desktop.txt (see README, Desktop app).",
                file=sys.stderr,
            )
        return 1
    finally:
        clear_instance(database)
        app.state.voice.shutdown()
        server.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
