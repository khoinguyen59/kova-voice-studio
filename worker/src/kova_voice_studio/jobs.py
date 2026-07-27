"""A bounded, single-GPU job queue for the Colab worker.

Colab has one volatile GPU process.  Running Demucs, Whisper and OmniVoice in
parallel makes the API appear to fail randomly and can exhaust VRAM.  Jobs are
therefore durable enough to inspect/reconnect to, while execution stays in one
process and one ordered queue.
"""

from __future__ import annotations

import json
from pathlib import Path
from queue import Full, Queue
from threading import Lock, Thread
from typing import Any, Callable
from uuid import uuid4

from .store import ProfileStore, WorkerJob


class JobCancelled(RuntimeError):
    """Raised between cancellable stages; GPU calls finish before cancellation."""


class JobContext:
    def __init__(self, store: ProfileStore, job_id: str) -> None:
        self._store = store
        self.job_id = job_id

    def update(self, stage: str, percent: int, message: str) -> None:
        self._store.update_job(
            self.job_id, status="running", stage=stage, percent=percent, message=message
        )

    def cancelled(self) -> bool:
        job = self._store.get_job(self.job_id)
        return job is None or job.cancel_requested

    def check_cancelled(self) -> None:
        if self.cancelled():
            raise JobCancelled("cancelled by user")


JobHandler = Callable[[JobContext], tuple[dict[str, Any], str]]


class JobQueue:
    def __init__(self, store: ProfileStore, work_root: Path, max_pending: int = 4) -> None:
        self._store = store
        self._work_root = work_root
        self._queue: Queue[tuple[str, JobHandler]] = Queue(maxsize=max_pending)
        self._state_lock = Lock()
        self._running = False
        self._thread = Thread(target=self._run, name="kova-gpu-worker", daemon=True)
        self._thread.start()

    def submit(self, kind: str, message: str, handler: JobHandler) -> WorkerJob:
        job_id = uuid4().hex
        job = self._store.create_job(job_id, kind, message)
        try:
            self._queue.put_nowait((job_id, handler))
        except Full:
            return self._store.update_job(
                job_id,
                status="failed",
                stage="queue",
                percent=100,
                error_code="queue_full",
                error_detail="the Colab GPU queue is full; wait for a task to finish and retry",
            )
        return job

    def cancel(self, job_id: str) -> WorkerJob:
        existing = self._store.get_job(job_id)
        if existing is None:
            raise KeyError(job_id)
        if existing.status in {"succeeded", "failed", "cancelled"}:
            return existing
        job = self._store.request_job_cancel(job_id)
        if job.status == "queued":
            return self._store.update_job(
                job_id, status="cancelled", stage="cancelled", percent=100, message="cancelled"
            )
        return job

    @property
    def queue_depth(self) -> int:
        return self._queue.qsize()

    @property
    def busy(self) -> bool:
        with self._state_lock:
            return self._running or self._queue.qsize() > 0

    def _run(self) -> None:
        while True:
            job_id, handler = self._queue.get()
            try:
                with self._state_lock:
                    self._running = True
                job = self._store.get_job(job_id)
                if job is None or job.status == "cancelled" or job.cancel_requested:
                    if job is not None and job.status != "cancelled":
                        self._store.update_job(job_id, status="cancelled", stage="cancelled", percent=100)
                    continue
                context = JobContext(self._store, job_id)
                context.update("starting", 1, "worker accepted the job")
                result, result_path = handler(context)
                if context.cancelled():
                    self._store.update_job(job_id, status="cancelled", stage="cancelled", percent=100)
                    if result_path:
                        Path(result_path).unlink(missing_ok=True)
                    continue
                self._store.update_job(
                    job_id,
                    status="succeeded",
                    stage="complete",
                    percent=100,
                    message="complete",
                    result_json=json.dumps(result, ensure_ascii=False),
                    result_path=result_path,
                )
            except JobCancelled:
                self._store.update_job(job_id, status="cancelled", stage="cancelled", percent=100)
            except ValueError as error:
                self._store.update_job(
                    job_id,
                    status="failed",
                    stage="validation",
                    percent=100,
                    error_code="validation_failed",
                    error_detail=str(error)[:500],
                )
            except Exception as error:  # Keep the public protocol sanitized.
                self._store.update_job(
                    job_id,
                    status="failed",
                    stage="worker",
                    percent=100,
                    error_code="worker_failed",
                    error_detail=f"{type(error).__name__}: {str(error)[:500]}",
                )
            finally:
                with self._state_lock:
                    self._running = False
                self._queue.task_done()
