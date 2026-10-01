"""Run Personal Note in a Chromium app window (Linux launcher engine).

Standard library only. The window is a separate Chromium process with its own profile, so
its lifetime is trackable and it never joins the user's everyday browser.
"""

from __future__ import annotations

import shutil
import subprocess
import time
from pathlib import Path
from typing import Callable

BINARIES = ("chromium", "chromium-browser", "google-chrome-stable", "google-chrome")
WM_CLASS = "PersonalNote"
SETTLE_SECONDS = 0.4  # lets the page's closing save (pagehide, keepalive) reach the server
GRACE_SECONDS = 1.5  # upper bound on waiting for requests still in flight


def find_chromium(which: Callable[[str], str | None] = shutil.which) -> str | None:
    for name in BINARIES:
        found = which(name)
        if found:
            return found
    return None


def chromium_command(binary: str, url: str, profile_dir: Path) -> list[str]:
    return [
        binary,
        f"--app={url}",
        f"--user-data-dir={profile_dir}",
        f"--class={WM_CLASS}",  # window class / Wayland app id, matched by StartupWMClass and the compositor
        "--ozone-platform-hint=auto",  # native Wayland where available, X11 otherwise
        "--no-first-run",
        "--no-default-browser-check",
    ]


def server_is_idle(server) -> bool:
    """True when the uvicorn server has no request in flight."""
    inner = getattr(server, "_server", None)
    state = getattr(inner, "server_state", None)
    if state is None:
        return True
    return not getattr(state, "tasks", None)


def wait_for_idle(
    server,
    settle: float = SETTLE_SECONDS,
    grace: float = GRACE_SECONDS,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> None:
    """After the window process has exited: wait out the closing save, then return.

    Always waits `settle`, then returns as soon as nothing is in flight, and never waits
    longer than `grace` in total.
    """
    start = clock()
    sleep(settle)
    while not server_is_idle(server) and clock() - start < grace:
        sleep(0.05)


def focus_window(
    command: list[str],
    run: Callable = subprocess.run,
    which: Callable[[str], str | None] = shutil.which,
) -> bool:
    """Bring the running app window forward. Tries Hyprland; otherwise re-launching with the
    same profile makes Chromium hand the request to the running instance."""
    hyprctl = which("hyprctl")
    if hyprctl:
        try:
            result = run([hyprctl, "dispatch", "focuswindow", f"class:{WM_CLASS}"], capture_output=True, timeout=3)
            if result.returncode == 0 and b"ok" in (result.stdout or b"").lower():
                return True
        except (OSError, subprocess.SubprocessError):
            pass
    try:
        run(command, capture_output=True, timeout=5)
        return True
    except (OSError, subprocess.SubprocessError):
        return False


def run_chromium_window(
    base_url: str,
    binary: str,
    profile_dir: Path,
    server,
    popen: Callable = subprocess.Popen,
    run: Callable = subprocess.run,
    which: Callable[[str], str | None] = shutil.which,
    idle_wait: Callable = wait_for_idle,
) -> int:
    """Open the window, block until its process exits, then let the closing save land.

    The caller stops the server afterwards. Returns Chromium's exit code.
    """
    url = base_url + "/notes?host=desktop"  # same host flag as the pywebview window
    profile_dir.mkdir(parents=True, exist_ok=True)
    command = chromium_command(binary, url, profile_dir)
    server.on_focus = lambda: focus_window(command, run=run, which=which)
    process = popen(command)
    try:
        code = process.wait()
    finally:
        idle_wait(server)
    return code
