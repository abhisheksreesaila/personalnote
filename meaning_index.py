"""The quiet background index for search by meaning (F-079).

One daemon thread polls the database (so a write from the CLI, another process, is noticed the same way as one from the
page), and when the search runtime is installed embeds the notes whose vector is missing or old. It never runs on a
request: saving, typing, startup and the speed test do not call it. All reads and writes go through NoteService.

Debounce: a note is indexed only once it has been saved and left alone for `idle` seconds.
Failures: an engine that errors is logged, shown in the status, and retried with a growing wait (30 s, doubling to 10 min).
"""

from __future__ import annotations

import logging
import threading
import time

from search_runtime import SearchError

logger = logging.getLogger("personal-note.search.index")

IDLE_SECONDS = 4.0
POLL_SECONDS = 3.0
BATCH = 4
FIRST_BACKOFF = 30.0
MAX_BACKOFF = 600.0


class MeaningIndexer:
    def __init__(self, service, runtime, idle: float = IDLE_SECONDS, poll: float = POLL_SECONDS, batch: int = BATCH, clock=time.monotonic):
        self.service, self.runtime = service, runtime
        self.idle, self.poll, self.batch, self.clock = idle, poll, batch, clock
        self.error = ""
        self._retry_at = 0.0
        self._backoff = FIRST_BACKOFF
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self._loop, name="meaning-index", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                busy = self.run_once()
            except Exception:  # the index must never take the app down; the next poll tries again
                logger.exception("event=search.index outcome=failed")
                busy = False
            self._stop.wait(0.05 if busy else self.poll)

    def run_once(self) -> int:
        """Embed one batch of notes that need it; returns how many were stored (0 when idle, not installed, or backing off)."""
        if not self.runtime.installed() or self.clock() < self._retry_at:
            return 0
        work = self.service.meaning_work(self.runtime.model_id, self.idle, self.batch)
        if not work:
            self.error = ""
            return 0
        try:
            vectors = self.runtime.embed([(item["title"], item["text"]) for item in work], kind="document")
        except SearchError as error:
            self.error = str(error)
            self._retry_at = self.clock() + self._backoff
            logger.warning("event=search.index outcome=engine_failed retry_in=%ds error=%s", self._backoff, error)
            self._backoff = min(self._backoff * 2, MAX_BACKOFF)
            return 0
        self.error, self._backoff = "", FIRST_BACKOFF
        self.service.store_meaning(self.runtime.model_id, list(zip(work, vectors)))
        return len(work)

    def status(self) -> dict:
        return {**self.service.meaning_counts(self.runtime.model_id), "error": self.error}
