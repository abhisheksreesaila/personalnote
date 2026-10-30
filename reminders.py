"""Reminders for due mind-map nodes (F-110).

One daemon thread asks `NoteService` which reminders are due and fires each once through `system_notify`. Nothing leaves the
machine and nothing here runs on a request: saving, typing and startup never wait on it. The list of due nodes is a derived table
(`mindmap_reminders`) that `NoteService` keeps on every map save; the thread never opens a map.

Jump to the node: on Linux the notice carries an "Open" action (notify-send --wait) and a click is remembered; on a Mac the
system notice cannot report a click, so for two minutes after any notice the next time the window gains focus counts as the click.
The browser asks `GET /api/reminders/jump` when its window gains focus, and gets each target once.
"""

from __future__ import annotations

import logging
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
TITLE = "Personal Note"


def system_notify(title: str, body: str, on_click=None, platform: str = sys.platform, which=shutil.which, run=subprocess.run) -> bool:
    """Show one system notification; True when a tool took it. `on_click` (Linux only) is called if the person clicks it."""
    try:
        if platform.startswith("linux"):
            binary = which("notify-send")
            if not binary:
                return False
            if on_click is None:
                run([binary, title, body], timeout=30)
                return True
            result = run([binary, "--wait", "--action=default=Open", title, body], capture_output=True, text=True, timeout=600)
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
    except (OSError, subprocess.SubprocessError):
        logger.warning("event=reminders.notify outcome=failed")
        return False
    logger.info("event=reminders.notify outcome=unsupported platform=%s", platform)  # Windows: best effort, no notice yet
    return False


class Reminders:
    def __init__(self, service, notify=None, clock=datetime.now, poll: float = POLL_SECONDS):
        self.service, self.clock, self.poll = service, clock, poll
        self.click_aware = notify is None and sys.platform.startswith("linux")
        self.notify = notify or self._desktop_notice
        self._target = None  # the reminder last sent; what a click with no target means
        self._lock = threading.Lock()
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
        """At start: whatever came due while closed becomes one notice, and counts as fired."""
        missed = self.service.reminders_due(self.now())
        if not missed:
            return
        for item in missed:
            self.service.mark_reminder_fired(item["noteId"], item["nodeId"], item["due"])
        self._send(f"You missed {len(missed)} reminder{'s' if len(missed) != 1 else ''}", missed[-1])

    def tick(self) -> int:
        """Fire every reminder now due, once each; returns how many."""
        due = self.service.reminders_due(self.now())
        for item in due:
            self.service.mark_reminder_fired(item["noteId"], item["nodeId"], item["due"])  # first, so a slow notice is never sent twice
            self._send(f"{item['label'] or 'A node'} — in {item['title']}", item)
        return len(due)

    def _send(self, body: str, target: dict) -> None:
        logger.info("event=reminders.fire note_id=%s node_id=%s", target["noteId"], target["nodeId"])
        self._target = target
        if self.click_aware:  # the notice waits for a click, so it gets a thread of its own
            threading.Thread(target=self._desktop_notice, args=(TITLE, body, target), name="reminder-notice", daemon=True).start()
            return
        self._arm_jump(target, time.monotonic() + JUMP_WINDOW_SECONDS)
        self.notify(TITLE, body)

    def _desktop_notice(self, title: str, body: str, target: dict | None = None) -> bool:
        return system_notify(title, body, on_click=(lambda: self.clicked(target)) if self.click_aware else None)

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
