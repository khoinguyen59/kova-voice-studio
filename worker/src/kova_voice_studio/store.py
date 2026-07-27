"""Small SQLite persistence layer for immutable, consented voice profiles."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
import sqlite3
from threading import RLock
from uuid import uuid4


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


@dataclass(frozen=True)
class Profile:
    id: str
    name: str
    language: str
    status: str
    created_at: str


@dataclass(frozen=True)
class ProfileVersion:
    id: str
    profile_id: str
    version: int
    reference_filename: str
    reference_sha256: str
    reference_path: str
    reference_duration_seconds: float
    # Exact user-reviewed words in the persisted reference clip. This is the
    # conditioning transcript, not generated output text.
    reference_text: str
    engine: str
    engine_version: str
    consent_at: str
    created_at: str


@dataclass(frozen=True)
class WorkerJob:
    id: str
    kind: str
    status: str
    stage: str
    percent: int
    message: str
    error_code: str
    error_detail: str
    result_json: str
    result_path: str
    cancel_requested: bool
    created_at: str
    updated_at: str


class ProfileStore:
    def __init__(self, database_path: str | Path) -> None:
        self._path = Path(database_path)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = RLock()
        self._connection = sqlite3.connect(self._path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        self._migrate()

    def close(self) -> None:
        with self._lock:
            self._connection.close()

    def _migrate(self) -> None:
        self._connection.executescript(
            """
            PRAGMA foreign_keys = ON;
            CREATE TABLE IF NOT EXISTS profiles (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              language TEXT NOT NULL,
              status TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS profile_versions (
              id TEXT PRIMARY KEY,
              profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
              version INTEGER NOT NULL,
              reference_filename TEXT NOT NULL,
              reference_sha256 TEXT NOT NULL,
              reference_path TEXT NOT NULL DEFAULT '',
              reference_duration_seconds REAL NOT NULL DEFAULT 0,
              reference_text TEXT NOT NULL DEFAULT '',
              engine TEXT NOT NULL,
              engine_version TEXT NOT NULL,
              consent_at TEXT NOT NULL,
              created_at TEXT NOT NULL,
              UNIQUE(profile_id, version)
            );
            CREATE TABLE IF NOT EXISTS worker_jobs (
              id TEXT PRIMARY KEY,
              kind TEXT NOT NULL,
              status TEXT NOT NULL,
              stage TEXT NOT NULL,
              percent INTEGER NOT NULL,
              message TEXT NOT NULL DEFAULT '',
              error_code TEXT NOT NULL DEFAULT '',
              error_detail TEXT NOT NULL DEFAULT '',
              result_json TEXT NOT NULL DEFAULT '',
              result_path TEXT NOT NULL DEFAULT '',
              cancel_requested INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_worker_jobs_updated_at ON worker_jobs(updated_at DESC);
            """
        )
        self._connection.commit()

        # The first development builds did not persist the worker-owned path.
        # Keep this migration idempotent so a profile database is never lost.
        columns = {row[1] for row in self._connection.execute("PRAGMA table_info(profile_versions)")}
        if "reference_path" not in columns:
            self._connection.execute("ALTER TABLE profile_versions ADD COLUMN reference_path TEXT NOT NULL DEFAULT ''")
            self._connection.commit()
        if "reference_duration_seconds" not in columns:
            self._connection.execute("ALTER TABLE profile_versions ADD COLUMN reference_duration_seconds REAL NOT NULL DEFAULT 0")
            self._connection.commit()
        if "reference_text" not in columns:
            self._connection.execute("ALTER TABLE profile_versions ADD COLUMN reference_text TEXT NOT NULL DEFAULT ''")
            self._connection.commit()

        # Jobs cannot safely resume after a Colab restart because model memory
        # and temporary files are process-local. Preserve their record, but
        # make the interruption explicit instead of leaving a task "running".
        now = utc_now()
        self._connection.execute(
            """UPDATE worker_jobs
               SET status = 'failed', stage = 'interrupted', percent = 100,
                   error_code = 'worker_restarted',
                   error_detail = 'worker restarted while the job was active',
                   updated_at = ?
               WHERE status IN ('queued', 'running')""",
            (now,),
        )
        self._connection.commit()

    def create_profile(
        self,
        *,
        name: str,
        language: str,
        reference_filename: str,
        reference_sha256: str,
        reference_path: str = "",
        reference_duration_seconds: float = 0,
        reference_text: str = "",
        consent: bool,
        engine: str = "omnivoice",
        engine_version: str = "pending",
    ) -> tuple[Profile, ProfileVersion]:
        if not consent:
            raise ValueError("voice consent is required")
        if not name.strip() or not reference_filename.strip() or len(reference_sha256.strip()) != 64 or reference_duration_seconds < 0:
            raise ValueError("profile name, reference filename, and SHA-256 are required")
        if not reference_text.strip() or len(reference_text.strip()) > 2_000:
            raise ValueError("an exact reference transcript of at most 2,000 characters is required")
        now = utc_now()
        profile = Profile(uuid4().hex, name.strip(), language.strip() or "vi", "ready", now)
        version = ProfileVersion(
            uuid4().hex,
            profile.id,
            1,
            reference_filename.strip(),
            reference_sha256.lower().strip(),
            reference_path.strip(),
            float(reference_duration_seconds),
            reference_text.strip(),
            engine.strip() or "omnivoice",
            engine_version.strip() or "pending",
            now,
            now,
        )
        with self._lock, self._connection:
            self._connection.execute(
                "INSERT INTO profiles(id, name, language, status, created_at) VALUES (?, ?, ?, ?, ?)",
                (profile.id, profile.name, profile.language, profile.status, profile.created_at),
            )
            self._connection.execute(
                """INSERT INTO profile_versions(id, profile_id, version, reference_filename,
                   reference_sha256, reference_path, reference_duration_seconds, reference_text, engine, engine_version, consent_at, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    version.id,
                    version.profile_id,
                    version.version,
                    version.reference_filename,
                    version.reference_sha256,
                    version.reference_path,
                    version.reference_duration_seconds,
                    version.reference_text,
                    version.engine,
                    version.engine_version,
                    version.consent_at,
                    version.created_at,
                ),
            )
        return profile, version

    def set_reference_path(self, version_id: str, reference_path: str) -> None:
        with self._lock, self._connection:
            self._connection.execute(
                "UPDATE profile_versions SET reference_path = ? WHERE id = ?",
                (reference_path, version_id),
            )

    def create_job(self, job_id: str, kind: str, message: str = "") -> WorkerJob:
        now = utc_now()
        job = WorkerJob(job_id, kind, "queued", "queued", 0, message, "", "", "", "", False, now, now)
        with self._lock, self._connection:
            self._connection.execute(
                """INSERT INTO worker_jobs(id, kind, status, stage, percent, message, error_code,
                   error_detail, result_json, result_path, cancel_requested, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    job.id, job.kind, job.status, job.stage, job.percent, job.message,
                    job.error_code, job.error_detail, job.result_json, job.result_path,
                    int(job.cancel_requested), job.created_at, job.updated_at,
                ),
            )
        return job

    def update_job(
        self,
        job_id: str,
        *,
        status: str | None = None,
        stage: str | None = None,
        percent: int | None = None,
        message: str | None = None,
        error_code: str | None = None,
        error_detail: str | None = None,
        result_json: str | None = None,
        result_path: str | None = None,
    ) -> WorkerJob:
        current = self.get_job(job_id)
        if current is None:
            raise KeyError(job_id)
        values = {
            "status": current.status if status is None else status,
            "stage": current.stage if stage is None else stage,
            "percent": current.percent if percent is None else max(0, min(100, int(percent))),
            "message": current.message if message is None else message,
            "error_code": current.error_code if error_code is None else error_code,
            "error_detail": current.error_detail if error_detail is None else error_detail,
            "result_json": current.result_json if result_json is None else result_json,
            "result_path": current.result_path if result_path is None else result_path,
            "updated_at": utc_now(),
        }
        with self._lock, self._connection:
            self._connection.execute(
                """UPDATE worker_jobs SET status = ?, stage = ?, percent = ?, message = ?,
                   error_code = ?, error_detail = ?, result_json = ?, result_path = ?, updated_at = ?
                   WHERE id = ?""",
                (
                    values["status"], values["stage"], values["percent"], values["message"],
                    values["error_code"], values["error_detail"], values["result_json"],
                    values["result_path"], values["updated_at"], job_id,
                ),
            )
        updated = self.get_job(job_id)
        assert updated is not None
        return updated

    def request_job_cancel(self, job_id: str) -> WorkerJob:
        with self._lock, self._connection:
            changed = self._connection.execute(
                "UPDATE worker_jobs SET cancel_requested = 1, updated_at = ? WHERE id = ?",
                (utc_now(), job_id),
            ).rowcount
        if not changed:
            raise KeyError(job_id)
        job = self.get_job(job_id)
        assert job is not None
        return job

    def get_job(self, job_id: str) -> WorkerJob | None:
        with self._lock:
            row = self._connection.execute(
                """SELECT id, kind, status, stage, percent, message, error_code, error_detail,
                   result_json, result_path, cancel_requested, created_at, updated_at
                   FROM worker_jobs WHERE id = ?""",
                (job_id,),
            ).fetchone()
        if row is None:
            return None
        values = dict(row)
        values["cancel_requested"] = bool(values["cancel_requested"])
        return WorkerJob(**values)

    def list_profiles(self) -> list[Profile]:
        with self._lock:
            rows = self._connection.execute(
                "SELECT id, name, language, status, created_at FROM profiles ORDER BY created_at DESC"
            ).fetchall()
        return [Profile(**dict(row)) for row in rows]

    def get_profile(self, profile_id: str) -> Profile | None:
        with self._lock:
            row = self._connection.execute(
                "SELECT id, name, language, status, created_at FROM profiles WHERE id = ?", (profile_id,)
            ).fetchone()
        return Profile(**dict(row)) if row else None

    def latest_version(self, profile_id: str) -> ProfileVersion | None:
        with self._lock:
            row = self._connection.execute(
                """SELECT id, profile_id, version, reference_filename, reference_sha256, reference_path, reference_duration_seconds, reference_text, engine,
                   engine_version, consent_at, created_at FROM profile_versions
                   WHERE profile_id = ? ORDER BY version DESC LIMIT 1""",
                (profile_id,),
            ).fetchone()
        return ProfileVersion(**dict(row)) if row else None

    def delete_profile(self, profile_id: str) -> list[str]:
        """Delete a profile and return only its worker-owned reference paths."""
        with self._lock, self._connection:
            rows = self._connection.execute(
                "SELECT reference_path FROM profile_versions WHERE profile_id = ?", (profile_id,)
            ).fetchall()
            deleted = self._connection.execute("DELETE FROM profiles WHERE id = ?", (profile_id,)).rowcount
        if not deleted:
            raise KeyError(profile_id)
        return [str(row["reference_path"]) for row in rows if str(row["reference_path"])]
