"""Platform pieces secure notes need (F-056): Touch ID, a keychain key, and hiding a window from capture.

macOS only, through pyobjc (already present because pywebview's Cocoa backend needs it):
- `authenticate(reason)`: LocalAuthentication, Touch ID with the Mac password as the fallback.
- `key_get_or_create()`: a random 32-byte key kept as a generic password item in the login keychain.
  It is released only shortly after a successful `authenticate`.
- `set_capture_hidden(window, hidden)`: NSWindow sharingType none/read-only, so screen sharing and
  screenshots leave the window out.

Everywhere else `available()` is False and the three calls raise `Unavailable`; the Linux app asks for a
passphrase instead. The key is never logged or returned in a message. UNVERIFIED on a Mac until the
Help > "Test secure unlock…" item has been run there.
"""

from __future__ import annotations

import logging
import secrets
import sys
import threading
import time
from typing import Any, Callable

logger = logging.getLogger("personal-note.secure")

SERVICE = "Personal Note secure notes"
ACCOUNT = "secure-notes-key"
KEY_BYTES = 32
UNLOCK_WINDOW_SECONDS = 120.0  # how long a Touch ID yes lets the key be read
AUTH_TIMEOUT_SECONDS = 120.0
CAPTURE_HIDDEN_SECONDS = 10.0
PASSPHRASE_MESSAGE = "This computer uses a passphrase for secure notes"

# NSWindowSharingType
SHARING_NONE = 0
SHARING_READ_ONLY = 1
# LAPolicyDeviceOwnerAuthentication: biometrics, falling back to the account password.
LA_POLICY_OWNER_AUTH = 2
ERR_SEC_ITEM_NOT_FOUND = -25300
ERR_SEC_DUPLICATE_ITEM = -25299  # another writer added the key first: just read it back
_test_lock = threading.Lock()

_authenticated_at: float | None = None


class Unavailable(Exception):
    """This computer has no Touch ID / keychain / capture exclusion (use a passphrase instead)."""


class NotAuthenticated(Exception):
    """The key was asked for without a recent Touch ID yes."""


def available(platform: str | None = None) -> bool:
    return (sys.platform if platform is None else platform) == "darwin"


def backend(platform: str | None = None) -> str:
    """"touchid" on a Mac, "passphrase" elsewhere."""
    return "touchid" if available(platform) else "passphrase"


def _require_mac() -> None:
    if not available():
        raise Unavailable(PASSPHRASE_MESSAGE)


# ---- Touch ID ---------------------------------------------------------------------------------


def authenticate(reason: str, timeout: float = AUTH_TIMEOUT_SECONDS) -> bool:
    """Ask for Touch ID (or the Mac password). True only on a yes; any failure or cancel is False.

    The system answers on its own queue, so this waits on an Event and must not be called from the
    AppKit main thread (the menu runs it on a worker thread).
    """
    global _authenticated_at
    _require_mac()
    if threading.current_thread() is threading.main_thread():
        raise RuntimeError("authenticate() waits for the system dialog; call it from a worker thread")
    try:
        from LocalAuthentication import LAContext

        context = LAContext.alloc().init()
        can, error = context.canEvaluatePolicy_error_(LA_POLICY_OWNER_AUTH, None)
        if not can:
            logger.warning("Touch ID / password prompt not available: %s", error)
            return False
        done = threading.Event()
        box: dict[str, bool] = {"ok": False}

        def reply(success, _error):
            box["ok"] = bool(success)
            done.set()

        context.evaluatePolicy_localizedReason_reply_(LA_POLICY_OWNER_AUTH, reason, reply)
        if not done.wait(timeout):
            context.invalidate()
            return False
        if box["ok"]:
            _authenticated_at = time.monotonic()
        return box["ok"]
    except Exception:
        logger.warning("Touch ID check failed.", exc_info=True)
        return False


def forget_authentication() -> None:
    global _authenticated_at
    _authenticated_at = None


def _recently_authenticated(now: Callable[[], float] = time.monotonic) -> bool:
    return _authenticated_at is not None and now() - _authenticated_at <= UNLOCK_WINDOW_SECONDS


# ---- Keychain ---------------------------------------------------------------------------------


def _query(security: Any) -> dict:
    return {
        security.kSecClass: security.kSecClassGenericPassword,
        security.kSecAttrService: SERVICE,
        security.kSecAttrAccount: ACCOUNT,
    }


def _keychain_read(security: Any) -> bytes | None:
    query = _query(security)
    query[security.kSecReturnData] = True
    query[security.kSecMatchLimit] = security.kSecMatchLimitOne
    status, data = security.SecItemCopyMatching(query, None)
    if status == ERR_SEC_ITEM_NOT_FOUND:
        return None
    if status != 0:
        raise OSError(f"keychain read failed ({status})")
    return bytes(data)


def _keychain_add(security: Any, key: bytes) -> None:
    from Foundation import NSData

    item = _query(security)
    item[security.kSecValueData] = NSData.dataWithBytes_length_(key, len(key))
    status, _ = security.SecItemAdd(item, None)
    if status not in (0, ERR_SEC_DUPLICATE_ITEM):
        raise OSError(f"keychain write failed ({status})")


def key_get_or_create(security: Any = None) -> bytes:
    """The 32-byte secure-notes key from the login keychain, created on first use.

    Raises NotAuthenticated unless `authenticate` said yes in the last two minutes.
    """
    _require_mac()
    if not _recently_authenticated():
        raise NotAuthenticated("Touch ID is needed first")
    if security is None:
        import Security as security  # noqa: N813
    key = _keychain_read(security)
    if key is None:
        _keychain_add(security, secrets.token_bytes(KEY_BYTES))
        key = _keychain_read(security)
    if key is None or len(key) != KEY_BYTES:
        raise OSError("the stored key could not be read back")
    return key


# ---- Capture exclusion ------------------------------------------------------------------------


def set_capture_hidden(window: Any, hidden: bool) -> bool:
    """Keep the window out of screen sharing and screenshots (or let it back in). True when applied."""
    _require_mac()
    native = getattr(window, "native", None)
    if native is None:
        return False
    value = SHARING_NONE if hidden else SHARING_READ_ONLY

    def apply():
        native.setSharingType_(value)
        return True

    try:
        if threading.current_thread() is threading.main_thread():
            return apply()
        from PyObjCTools import AppHelper

        done = threading.Event()
        box: dict[str, bool] = {}

        def call():
            try:
                box["ok"] = apply()
            finally:
                done.set()

        AppHelper.callAfter(call)
        return done.wait(5.0) and box.get("ok", False)
    except Exception:
        logger.warning("Could not change the window's screen-share setting.", exc_info=True)
        return False


# ---- Sleep and screen lock ----------------------------------------------------------------------

WORKSPACE_LOCK_EVENTS = (
    ("NSWorkspaceWillSleepNotification", "sleep"),
    ("NSWorkspaceScreensDidSleepNotification", "screen sleep"),
    ("NSWorkspaceSessionDidResignActiveNotification", "session switch"),
)
DISTRIBUTED_LOCK_EVENTS = (
    ("com.apple.screenIsLocked", "screen locked"),
    ("com.apple.screensaver.didstart", "screen saver"),
)


def watch_lock_events(callback: Callable[[str], None], workspace: Any = None, distributed: Any = None) -> Callable[[], None] | None:
    """Calls `callback(reason)` when the Mac goes to sleep, the screen sleeps or locks, the screen saver starts, or another user takes over.

    Secure notes lock on every one of these. Returns a function that stops watching, or None off a Mac. A callback that raises is
    logged, never passed on to AppKit. UNVERIFIED on a Mac until tried there.
    """
    if workspace is None and not available():
        return None
    try:
        if workspace is None:
            from AppKit import NSWorkspace

            workspace = NSWorkspace.sharedWorkspace()
        if distributed is None:
            from Foundation import NSDistributedNotificationCenter

            distributed = NSDistributedNotificationCenter.defaultCenter()
    except Exception:
        logger.warning("Could not watch for sleep and screen lock.", exc_info=True)
        return None

    def handler(reason: str):
        def run(_notification):
            try:
                callback(reason)
            except Exception:
                logger.warning("Locking secure notes on %s failed.", reason, exc_info=True)

        return run

    registered: list[tuple[Any, Any]] = []
    try:
        center = workspace.notificationCenter()
        for name, reason in WORKSPACE_LOCK_EVENTS:
            registered.append((center, center.addObserverForName_object_queue_usingBlock_(name, None, None, handler(reason))))
        for name, reason in DISTRIBUTED_LOCK_EVENTS:
            registered.append((distributed, distributed.addObserverForName_object_queue_usingBlock_(name, None, None, handler(reason))))
    except Exception:
        logger.warning("Could not watch for sleep and screen lock.", exc_info=True)

    def stop() -> None:
        for center, token in registered:
            try:
                center.removeObserver_(token)
            except Exception:
                logger.warning("Could not stop watching for sleep.", exc_info=True)
        registered.clear()

    return stop


# ---- The Help > "Test secure unlock…" check -----------------------------------------------------


def run_self_test(
    window: Any,
    notify: Callable[[str], None],
    pause: Callable[[float], None] = time.sleep,
    platform: str | None = None,
) -> list[str]:
    """Runs all three pieces and reports each outcome in plain words (never the key). Never raises."""
    if not available(platform):
        notify(PASSPHRASE_MESSAGE)
        return [PASSPHRASE_MESSAGE]
    if not _test_lock.acquire(blocking=False):
        notify("Secure unlock test is already running")
        return ["already running"]
    try:
        return _run_self_test(window, notify, pause)
    finally:
        _test_lock.release()


def _run_self_test(window: Any, notify: Callable[[str], None], pause: Callable[[float], None]) -> list[str]:
    lines: list[str] = []
    try:
        ok = authenticate("Personal Note is testing secure unlock")
        lines.append("Touch ID: yes" if ok else "Touch ID: no (cancelled or not available)")
        if ok:
            try:
                key = key_get_or_create()
                lines.append(f"Keychain: key stored and read back OK ({len(key)} bytes)")
            except Exception as error:
                logger.warning("Keychain step failed.", exc_info=True)
                lines.append(f"Keychain: failed ({error})")
        else:
            lines.append("Keychain: skipped (no Touch ID yes)")
        if set_capture_hidden(window, True):
            notify(f"Window hidden from screen sharing for {int(CAPTURE_HIDDEN_SECONDS)} seconds")
            try:
                pause(CAPTURE_HIDDEN_SECONDS)
            finally:
                restored = set_capture_hidden(window, False)
            lines.append("Window hidden from capture for 10 seconds, then restored" if restored else "Window hidden, but NOT restored: restart the app")
        else:
            lines.append("Window hiding: failed")
    except Exception:
        logger.warning("Secure unlock test failed.", exc_info=True)
        lines.append("Test stopped by an error (see the log)")
    notify(" | ".join(lines))
    return lines
