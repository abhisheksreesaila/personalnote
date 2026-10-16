"""The quiet background index for search by meaning (F-079).

One daemon thread watches the database (so a write from the CLI, another process, is noticed the same way as one from the
page), and when the search runtime is installed embeds the notes whose vector is missing or old. It never runs on a
request: saving, typing, startup and the speed test do not call it. All reads and writes go through NoteService.

Quiet by design, so typing never feels it:
- a note is indexed only after it has been left alone for `idle` seconds (30);
- one small batch at a time, with a pause between batches;
- the database is read only when its change counter moved (or on a slow safety poll), not on every wake-up;
- once the index has caught up and nothing has embedded for 5 minutes the engine is stopped; the next use starts it.

Failures: an engine that is down is logged, shown in the status, and retried with a growing wait (30 s, doubling to 10 min).
A note the engine refuses (too long for it) is retried alone, then left out until it changes; it never blocks the others.
"""

from __future__ import annotations

import logging
import threading
import time

from search_runtime import SearchError, SearchInputError

logger = logging.getLogger("personal-note.search.index")

IDLE_SECONDS = 30.0
POLL_SECONDS = 3.0
PAUSE_SECONDS = 1.0
SAFETY_POLL_SECONDS = 60.0
ENGINE_IDLE_SECONDS = 300.0
BATCH = 4
FIRST_BACKOFF = 30.0
MAX_BACKOFF = 600.0
JOIN_SECONDS = 10.0


class MeaningIndexer:
    def __init__(self, service, runtime, idle: float = IDLE_SECONDS, poll: float = POLL_SECONDS, batch: int = BATCH, pause: float = PAUSE_SECONDS, clock=time.monotonic):
        self.service, self.runtime = service, runtime
        self.idle, self.poll, self.batch, self.pause, self.clock = idle, poll, batch, pause, clock
        self.error = ""
        self.failed: dict[int, int] = {}  # note id -> the revision the engine refused; left out until the note changes
        self._retry_at = 0.0
        self._backoff = FIRST_BACKOFF
        self._settled: tuple | None = None  # (change counter, model) when the last pass found nothing left to do
        self._last_pass = 0.0
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self._loop, name="meaning-index", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        """Stop the thread and wait (briefly) for a batch in flight; call before the runtime's shutdown."""
        self._stop.set()
        thread = self._thread
        if thread is not None and thread is not threading.current_thread():
            thread.join(JOIN_SECONDS)

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                busy = self.tick() > 0
            except Exception:  # the index must never take the app down; the next poll tries again
                logger.exception("event=search.index outcome=failed")
                busy = False
            self._stop.wait(self.pause if busy else self.poll)

    def tick(self) -> int:
        """One wake-up of the thread: do a pass only if something may have changed. Returns how many notes were stored."""
        if not self.runtime.installed():
            return 0
        model = self.runtime.model_id
        sequence = self.service.workspace_sequence()
        if self._settled == (sequence, model) and self.clock() - self._last_pass < SAFETY_POLL_SECONDS:
            self.runtime.stop_if_idle(ENGINE_IDLE_SECONDS)
            return 0
        stored = self.run_once()
        self._last_pass = self.clock()
        if stored == 0 and not self.error and self.service.meaning_waiting(model, self.idle) == 0:
            self._settled = (sequence, model)
            self.runtime.stop_if_idle(ENGINE_IDLE_SECONDS)
        else:
            self._settled = None
        return stored

    def run_once(self) -> int:
        """Embed one batch of notes that need it; returns how many were stored (0 when idle, not installed, or backing off)."""
        if not self.runtime.installed() or self.clock() < self._retry_at:
            return 0
        model = self.runtime.model_id
        work = self.service.meaning_work(model, self.idle, self.batch, skip=self.failed)
        if not work:
            self.error = ""
            return 0
        try:
            vectors = self.runtime.embed([(item["title"], item["text"]) for item in work], kind="document")
        except SearchInputError:
            return self._one_by_one(work, model)  # one note in the batch is the problem: find it, keep the rest
        except SearchError as error:
            self._engine_failed(error)
            return 0
        self.error, self._backoff = "", FIRST_BACKOFF
        self._keep(work, vectors, model)
        return len(work)

    def _one_by_one(self, work: list[dict], model: str) -> int:
        stored = 0
        for item in work:
            try:
                (vector,) = self.runtime.embed([(item["title"], item["text"])], kind="document")
            except SearchInputError:
                self.failed[item["id"]] = item["revision"]
                logger.warning("event=search.index outcome=note_refused note_id=%s revision=%s", item["id"], item["revision"])
                continue
            except SearchError as error:  # the engine itself went down: not this note's fault
                self._engine_failed(error)
                break
            self._keep([item], [vector], model)
            stored += 1
        else:
            self.error, self._backoff = "", FIRST_BACKOFF
        return stored

    def _keep(self, work: list[dict], vectors: list, model: str) -> None:
        self.service.store_meaning(model, list(zip(work, vectors)))
        for item in work:
            self.failed.pop(item["id"], None)

    def _engine_failed(self, error: SearchError) -> None:
        self.error = str(error)
        self._retry_at = self.clock() + self._backoff
        logger.warning("event=search.index outcome=engine_failed retry_in=%ds error=%s", self._backoff, error)
        self._backoff = min(self._backoff * 2, MAX_BACKOFF)

    def status(self) -> dict:
        return {**self.service.meaning_counts(self.runtime.model_id), "error": self.error, "failed": len(self.failed)}
