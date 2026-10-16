"""X bookmarks in the app (F-088): connect, and the quiet sync that files new bookmarks as notes.

One daemon thread (like meaning_index.py) syncs a few seconds after the app opens and then every hour, only when X is
connected, and never on a request, so capture never waits on it. Everything runs under one lock: X rotates the refresh
token on every use, so two syncs (or a sync and a sign-in) at once would break the sign-in. Errors are kept for Settings
to show; none is raised out of the thread. The notes are written by NoteService.import_x_bookmarks.
"""

from __future__ import annotations

import logging
import os
import re
import threading
import webbrowser
from datetime import datetime, timezone
from pathlib import Path

import x_bookmarks
from secret_store import SecretStore, SecretStoreError
from x_bookmarks import XClient, XError

logger = logging.getLogger("personal-note.x.sync")

INTERVAL_SECONDS = 3600.0
FIRST_DELAY_SECONDS = 5.0  # a short-lived process (a command, a test) never gets as far as the network
KNOWN_IDS = 20
JOIN_SECONDS = 10.0
BUSY_WAIT_SECONDS = 35.0
CLIENT_ID_ENV = "PERSONAL_NOTE_X_CLIENT_ID"
CLIENT_ID_PATTERN = re.compile(r"[A-Za-z0-9_.:-]{4,200}")


class XSync:
    def __init__(self, service, *, token_store=None, client_id_secret=None, open_browser=webbrowser.open, client_options=None,
                 interval: float = INTERVAL_SECONDS, first_delay: float = FIRST_DELAY_SECONDS, folder: Path | None = None):
        self.service = service
        self.tokens = token_store if token_store is not None else x_bookmarks.default_token_store(folder=folder)
        self.client_id_secret = client_id_secret if client_id_secret is not None else SecretStore("Personal Note X client id", "x-client-id", folder=folder)
        self.open_browser = open_browser
        self.client_options = client_options or {}
        self.interval, self.first_delay = interval, first_delay
        self.error, self.error_kind = "", ""
        self.last_sync: str | None = None
        self.connecting = False
        self._lock = threading.Lock()  # one sign-in or sync at a time
        self._syncing = False
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    # -- thread

    def start(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self._loop, name="x-sync", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(JOIN_SECONDS)

    def _loop(self) -> None:
        wait = self.first_delay
        while not self._stop.wait(wait):
            wait = self.interval
            try:
                if self._connected():
                    self.sync()
            except Exception:  # never take the app down; the next hour tries again
                logger.exception("event=x.sync outcome=failed")

    # -- settings

    def _client(self, client_id: str | None = None) -> XClient:
        return XClient(client_id if client_id is not None else self._client_id(), self.tokens, **self.client_options)

    def _client_id(self) -> str:
        value = os.environ.get(CLIENT_ID_ENV, "").strip()
        if value:
            return value
        try:
            return (self.client_id_secret.load() or "").strip()
        except SecretStoreError:
            return ""

    def _connected(self) -> bool:
        return self._client("").signed_in()

    def set_client_id(self, value) -> None:
        value = str(value or "").strip()
        if not CLIENT_ID_PATTERN.fullmatch(value):
            raise XError("That does not look like an X client id. Copy it from the X developer console.")
        try:
            self.client_id_secret.save(value)
        except SecretStoreError:
            raise XError("The client id could not be saved on this computer.") from None

    def status(self) -> dict:
        return {
            "hasClientId": bool(self._client_id()),  # the id itself never goes to the page
            "connected": self._connected(),
            "connecting": self.connecting,
            "syncing": self._syncing,
            "lastSync": self.last_sync,
            "imported": self.service.x_imported_count(),
            "error": self.error,
            "errorKind": self.error_kind,
        }

    def _fail(self, error: XError) -> None:
        self.error, self.error_kind = str(error), error.kind

    # -- actions

    def connect(self) -> None:
        """Start the browser sign-in in the background (it waits for the person); Settings polls status for the result."""
        if not self._client_id():
            raise XError("Paste the X client id first (scripts/x-setup.sh shows where to find it).", "signed_out")
        if not self._lock.acquire(blocking=False):
            raise XError("X is busy. Try again in a moment.")
        self.connecting = True
        self.error, self.error_kind = "", ""
        threading.Thread(target=self._connect, name="x-connect", daemon=True).start()

    def _connect(self) -> None:  # holds the lock taken in connect()
        try:
            self._client().sign_in(self.open_browser)
            self._sync_locked()
        except XError as error:
            self._fail(error)
        except Exception:
            logger.exception("event=x.connect outcome=failed")
            self.error, self.error_kind = "X sign-in failed.", "other"
        finally:
            self.connecting = False
            self._lock.release()

    def sync(self) -> bool:
        """Fetch and file new bookmarks now. False when another sync or sign-in holds the lock (nothing is started)."""
        if not self._lock.acquire(blocking=False):
            return False
        try:
            self._sync_locked()
        finally:
            self._lock.release()
        return True

    def _sync_locked(self) -> None:
        self._syncing = True
        try:
            self.service.adopt_x_posts_from_notes()  # a restored backup has the notes but not the record of their post ids
            posts = self._client().fetch_new(self.service.x_known_ids(KNOWN_IDS), x_bookmarks.MAX_BOOKMARKS)
            self.service.import_x_bookmarks(posts)
            self.error, self.error_kind = "", ""
            self.last_sync = datetime.now(timezone.utc).isoformat(timespec="seconds")
        except XError as error:
            self._fail(error)
        except Exception:  # never fatal: the app and capture carry on, Settings shows it
            logger.exception("event=x.sync outcome=failed")
            self.error, self.error_kind = "The X sync failed. It will try again in an hour.", "other"
        finally:
            self._syncing = False

    def disconnect(self) -> None:
        if not self._lock.acquire(timeout=BUSY_WAIT_SECONDS):
            raise XError("X is busy. Try again in a moment.")
        try:
            self._client("").sign_out()
            self.error, self.error_kind = "", ""
        except (XError, SecretStoreError):
            raise XError("The X sign-in could not be removed from this computer.") from None
        finally:
            self._lock.release()
