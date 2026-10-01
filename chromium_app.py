"""Run Personal Note in a Chromium app window (Linux launcher engine).

Standard library only. The window is a separate Chromium process with its own profile, so
its lifetime is trackable and it never joins the user's everyday browser.
"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Callable

BINARIES = ("chromium", "chromium-browser", "google-chrome-stable", "google-chrome")
WM_CLASS = "PersonalNote"
SETTLE_SECONDS = 0.4  # lets the page's closing save (pagehide, keepalive) reach the server
GRACE_SECONDS = 1.5  # upper bound on waiting for requests still in flight


REAL_CHROMIUM = "/usr/lib/chromium/chromium"  # the wrapper at /usr/bin/chromium also reads ~/.config/chromium-flags.conf


def child_env(env: dict | None = None, frozen: bool | None = None) -> dict:
    """Environment for programs this app starts (Chromium, hyprctl).

    A PyInstaller app points LD_LIBRARY_PATH at its own bundled libraries and keeps the user's value in
    LD_LIBRARY_PATH_ORIG; handing the bundle's value on makes system programs load the wrong libraries.
    """
    env = dict(os.environ if env is None else env)
    if not (bool(getattr(sys, "frozen", False)) if frozen is None else frozen):
        return env
    original = env.pop("LD_LIBRARY_PATH_ORIG", "")
    if original:
        env["LD_LIBRARY_PATH"] = original
    else:
        env.pop("LD_LIBRARY_PATH", None)
    return env


def find_chromium(
    which: Callable[[str], str | None] = shutil.which,
    exists: Callable[[str], bool] = os.path.exists,
) -> str | None:
    for name in BINARIES:
        found = which(name)
        if found:
            # Start the real binary directly so the user's browser flags (extensions, ozone) do not apply.
            return REAL_CHROMIUM if name == "chromium" and exists(REAL_CHROMIUM) else found
    return None


def chromium_command(binary: str, url: str, profile_dir: Path) -> list[str]:
    return [
        binary,
        f"--app={url}",
        f"--user-data-dir={profile_dir}",
        f"--class={WM_CLASS}",  # best effort: sets the window class / app id; focusing goes by PID instead
        "--ozone-platform-hint=auto",  # native Wayland where available, X11 otherwise
        "--disable-extensions",
        "--no-first-run",
        "--no-default-browser-check",
    ]


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def is_chromium(pid: int, comm_dir: str = "/proc") -> bool:
    """Linux: the process named `pid` is a Chromium/Chrome (a recycled PID of another program is not)."""
    try:
        return Path(comm_dir, str(pid), "comm").read_text().strip().lower().startswith("chrom")
    except OSError:
        return False


def profile_owner_pid(
    profile_dir: Path,
    alive: Callable[[int], bool] = pid_alive,
    hostname: Callable[[], str] = socket.gethostname,
    is_chromium: Callable[[int], bool] = is_chromium,
) -> int | None:
    """PID of the live Chromium holding this profile (its SingletonLock symlink is `host-pid`), else None."""
    try:
        target = os.readlink(Path(profile_dir) / "SingletonLock")
        host, _, number = target.rpartition("-")
        pid = int(number)
    except (OSError, ValueError):
        return None
    if host != hostname() or not alive(pid):
        return None  # another machine's or a dead process's lock is stale
    return pid if is_chromium(pid) else None


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


def wait_for_profile_release(
    profile_dir: Path,
    own_pid: int | None,
    sleep: Callable[[float], None] = time.sleep,
    owner: Callable[[Path], int | None] = profile_owner_pid,
) -> None:
    """Chromium may hand the window to another process and exit; keep serving until that process is gone."""
    while True:
        pid = owner(profile_dir)
        if pid is None or pid == own_pid:
            return
        sleep(0.5)


def focus_window(
    pid: int | None,
    run: Callable = subprocess.run,
    which: Callable[[str], str | None] = shutil.which,
) -> bool:
    """Bring the window of Chromium process `pid` forward with Hyprland. Never opens another window."""
    hyprctl = which("hyprctl")
    if not hyprctl or pid is None:
        return False
    try:
        result = run([hyprctl, "dispatch", "focuswindow", f"pid:{pid}"], capture_output=True, timeout=3, env=child_env())
    except (OSError, subprocess.SubprocessError):
        return False
    out = result.stdout or b""
    out = out.decode("utf-8", "replace") if isinstance(out, bytes) else out
    return result.returncode == 0 and out.strip().lower() == "ok"


def run_chromium_window(
    base_url: str,
    binary: str,
    profile_dir: Path,
    server,
    popen: Callable = subprocess.Popen,
    run: Callable = subprocess.run,
    which: Callable[[str], str | None] = shutil.which,
    idle_wait: Callable = wait_for_idle,
    release_wait: Callable = wait_for_profile_release,
    owner: Callable[[Path], int | None] = profile_owner_pid,
) -> int:
    """Open the window, block until it is really gone, then let the closing save land.

    The caller stops the server afterwards. Returns Chromium's exit code.
    """
    url = base_url + "/notes?host=desktop&engine=chromium"  # host flag as in the pywebview window; engine selects the save timing
    profile_dir.mkdir(parents=True, exist_ok=True)
    command = chromium_command(binary, url, profile_dir)
    server.on_focus = lambda: focus_window(owner(profile_dir), run=run, which=which)
    process = popen(command, env=child_env())
    try:
        code = process.wait()
        release_wait(profile_dir, getattr(process, "pid", None))
    finally:
        idle_wait(server)
    return code
