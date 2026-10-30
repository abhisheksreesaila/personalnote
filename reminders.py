"""Reminders for due mind-map nodes (F-110).

One daemon thread asks `NoteService` which reminders are due and fires each once through `system_notify`. Nothing leaves the
machine and nothing here runs on a request: saving, typing and startup never wait on it. The list of due nodes is a derived table
(`mindmap_reminders`) that `NoteService` keeps on every map save; the thread never opens a map.

Jump to the node: on Linux the notice carries an "Open" action (notify-send --wait) and a click is remembered; on a Mac the
system notice cannot report a click, so for two minutes after any notice the next time the window gains focus counts as the click.
The browser asks `GET /api/reminders/jump` when its window gains focus, and gets each target once.
"""

from __future__ import annotations

import html
import logging
import os
import shutil
import subprocess
import sys
import threading
import time
from datetime import datetime

logger = logging.getLogger("personal-note.reminders")

POLL_SECONDS = 15.0
JOIN_SECONDS = 5.0
JUMP_WINDOW_SECONDS = 120.0
WAIT_SECONDS = 120.0  # how long a Linux notice waits for a click
MAX_WAITERS = 4  # at most this many click-wait threads at once; more notices are shown plainly
TITLE = "Personal Note"


WINDOWS_TOAST = r"""
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$text = $xml.GetElementsByTagName('text')
$text.Item(0).InnerText = $env:PN_TITLE
$text.Item(1).InnerText = $env:PN_BODY
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
"""


def system_notify(title: str, body: str, on_click=None, platform: str = sys.platform, which=shutil.which, run=subprocess.run, wait: float = WAIT_SECONDS) -> bool:
    """Show one system notification; True when a tool took it. `on_click` (Linux only) is called if the person clicks it."""
    try:
        if platform.startswith("linux"):
            binary = which("notify-send")
            if not binary:
                return False
            body = html.escape(body, quote=False)  # notify-send renders markup in the body: a label like "<b>x" is text, not markup
            if on_click is None:
                run([binary, title, body], timeout=30)
                return True
            try:
                result = run([binary, "--wait", "--action=default=Open", title, body], capture_output=True, text=True, timeout=wait)
            except subprocess.TimeoutExpired:  # nobody answered: the notice was shown, then we stopped waiting
                return True
            if result.returncode != 0:  # an older notify-send without actions: show it plainly
                run([binary, title, body], timeout=30)
            elif (result.stdout or "").strip():
                on_click()
            return True
        if platform == "darwin":
            binary = which("osascript")
            if not binary:
                return False
            quote = lambda text: text.replace("\\", "\\\\").replace('"', '\\"')
            run([binary, "-e", f'display notification "{quote(body)}" with title "{quote(title)}"'], timeout=30)
            return True
        if platform.startswith("win"):  # the built-in toast API through PowerShell; text goes in by environment, never into the script
            binary = which("powershell")
            if not binary:
                return False
            env = {**os.environ, "PN_TITLE": title, "PN_BODY": body}
            run([binary, "-NoProfile", "-NonInteractive", "-Command", WINDOWS_TOAST], env=env, timeout=30, check=True, creationflags=0x08000000)
            return True
    except (OSError, subprocess.SubprocessError):
        logger.warning("event=reminders.notify outcome=failed")
        return False
    logger.info("event=reminders.notify outcome=unsupported platform=%s", platform)
    return False


class Reminders:
    def __init__(self, service, notify=None, clock=datetime.now, poll: float = POLL_SECONDS):
        self.service, self.clock, self.poll = service, clock, poll
        self.click_aware = notify is None and sys.platform.startswith("linux")
        self.notify = notify or self._desktop_notice
        self._target = None  # the reminder last sent; what a click with no target means
        self._lock = threading.Lock()
        self._inflight: set = set()  # reminders being sent now, so a slow notice is never sent twice
        self._warned: set = set()
        self._waiters = threading.BoundedSemaphore(MAX_WAITERS)
        self._jump = None  # (target, expires at or None)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        """Catch up on what came due while the app was closed, then watch the clock. Capture never waits for this."""
        if self._thread is None or not self._thread.is_alive():
            self._stop = threading.Event()
            self._thread = threading.Thread(target=self._loop, args=(self._stop,), name="reminders", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(JOIN_SECONDS)

    def _loop(self, stop: threading.Event) -> None:
        try:
            self.catch_up()
        except Exception:
            logger.exception("event=reminders.catch_up outcome=failed")
        while not stop.wait(self.poll):
            try:
                self.tick()
            except Exception:  # a reminder must never take the app down; the next poll tries again
                logger.exception("event=reminders.tick outcome=failed")

    def now(self) -> str:
        return self.clock().strftime("%Y-%m-%dT%H:%M")

    def catch_up(self) -> None:
        """At start: whatever came due while closed becomes one notice, and counts as fired once it is shown. A click goes to the earliest."""
        missed = self.service.reminders_due(self.now())
        if missed:
            self._send(f"You missed {len(missed)} reminder{'s' if len(missed) != 1 else ''}", missed[0], missed)

    def tick(self) -> int:
        """Send every reminder now due and not already going out; each counts as fired only once its notice was taken."""
        with self._lock:
            due = [item for item in self.service.reminders_due(self.now()) if self._key(item) not in self._inflight]
        for item in due:
            self._send(f"{item['label'] or 'A node'} — in {item['title']}", item, [item])
        return len(due)

    @staticmethod
    def _key(item: dict) -> tuple:
        return (item["noteId"], item["nodeId"], item["due"])

    def _send(self, body: str, target: dict, items: list) -> None:
        logger.info("event=reminders.fire note_id=%s node_id=%s", target["noteId"], target["nodeId"])
        with self._lock:
            self._inflight.update(self._key(item) for item in items)
        wait = self.click_aware and self._waiters.acquire(blocking=False)
        if wait:  # the notice waits for a click, so it gets a thread of its own
            threading.Thread(target=self._deliver, args=(body, target, items, True), name="reminder-notice", daemon=True).start()
        else:
            self._deliver(body, target, items, False)

    def _deliver(self, body: str, target: dict, items: list, wait: bool) -> None:
        try:
            ok = self._desktop_notice(TITLE, body, target, wait) if self.click_aware else self.notify(TITLE, body)
        except Exception:
            logger.exception("event=reminders.notify outcome=crashed")
            ok = False
        finally:
            if wait:
                self._waiters.release()
        keys = [self._key(item) for item in items]
        if ok:
            for item in items:
                self.service.mark_reminder_fired(item["noteId"], item["nodeId"], item["due"])
            self._target = target
            if not wait:
                self._arm_jump(target, time.monotonic() + JUMP_WINDOW_SECONDS)
        elif not set(keys) <= self._warned:  # still unfired: the next poll tries again; say so once
            self._warned.update(keys)
            logger.warning("event=reminders.notify outcome=not_shown note_id=%s node_id=%s will_retry=1", target["noteId"], target["nodeId"])
        with self._lock:
            self._inflight.difference_update(keys)

    def _desktop_notice(self, title: str, body: str, target: dict | None = None, wait: bool = False) -> bool:
        return system_notify(title, body, on_click=(lambda: self.clicked(target)) if wait else None)

    def _arm_jump(self, target, expires) -> None:
        with self._lock:
            self._jump = (target, expires)

    def clicked(self, target=None) -> None:
        """The person opened a notice (or the app window came forward after one): the next jump goes to its node."""
        self._arm_jump(target or self._target, None)

    def take_jump(self) -> dict | None:
        with self._lock:
            jump, self._jump = self._jump, None
        if jump is None or jump[0] is None or (jump[1] is not None and time.monotonic() > jump[1]):
            return None
        return {"noteId": jump[0]["noteId"], "nodeId": jump[0]["nodeId"]}
