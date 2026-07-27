"""HTTP contract for the independent Voice Studio service."""

from __future__ import annotations

import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile
from threading import Lock

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .engine import engine
from .jobs import JobContext, JobQueue
from .store import ProfileStore, WorkerJob


class CreateProfileRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    language: str = "vi"
    reference_filename: str = Field(min_length=1, max_length=255)
    reference_sha256: str = Field(min_length=64, max_length=64, pattern=r"^[a-fA-F0-9]{64}$")
    reference_text: str = Field(min_length=1, max_length=2_000)
    consent: bool
    engine: str = "omnivoice"
    engine_version: str = "pending"


class GenerationJobRequest(BaseModel):
    text: str = Field(min_length=1, max_length=10_000)
    profile_id: str = Field(min_length=1, max_length=128)
    language: str = "vi"
    speed: float = Field(default=1.0, gt=0, le=2.0)
    num_step: int = Field(default=32, ge=1, le=64)
    duration: float | None = Field(default=None, gt=0)


MAX_REFERENCE_BYTES = 256 * 1024 * 1024
MIN_REFERENCE_SECONDS = 3.0
MAX_REFERENCE_SECONDS = 30.0
SAFE_FILENAME = re.compile(r"[^A-Za-z0-9._-]+")
_TRANSCRIBER_LOCK = Lock()
_TRANSCRIBERS: dict[tuple[str, str], object] = {}


def create_app(database_path: str | Path | None = None) -> FastAPI:
    path = Path(database_path or os.environ.get("KOVA_VOICE_DATA_DIR", "data"))
    if path.suffix != ".db":
        path = path / "voice-studio.db"
    store = ProfileStore(path)
    work_root = path.parent
    jobs = JobQueue(store, work_root / "jobs")
    app = FastAPI(title="KOVA Voice Studio", version="1.0.2.1")
    app.state.profile_store = store
    app.state.job_queue = jobs
    pairing_lock = Lock()
    pairing_claimed = False

    def require_token(request: Request) -> None:
        expected = os.environ.get("KOVA_VOICE_API_TOKEN", "").strip()
        if not expected:
            # Tests and explicitly opted-in local development can run without a
            # token. A Colab tunnel must never become public without one.
            if os.environ.get("KOVA_VOICE_ALLOW_UNAUTHENTICATED_LOCAL") == "1" or os.environ.get("PYTEST_CURRENT_TEST"):
                return
            raise HTTPException(status_code=503, detail="worker token is not configured")
        authorization = request.headers.get("Authorization", "")
        if not secrets.compare_digest(authorization, f"Bearer {expected}"):
            raise HTTPException(status_code=401, detail="invalid worker token")

    def health_payload() -> dict[str, object]:
        return {
            "status": "ready" if engine.ready() else "installed",
            "ready": engine.ready(),
            "device": engine.device,
            "dtype": engine.dtype,
            "api_version": "2.0",
            "protocol_min": "1.0",
            "protocol_max": "2.0",
            "queue_depth": jobs.queue_depth,
            "busy": jobs.busy,
            "name": "KOVA Voice Studio",
        }

    def job_payload(job: WorkerJob) -> dict[str, object]:
        result: object = None
        if job.result_json:
            try:
                result = json.loads(job.result_json)
            except json.JSONDecodeError:
                result = None
        payload: dict[str, object] = {
            "id": job.id,
            "kind": job.kind,
            "status": job.status,
            "stage": job.stage,
            "percent": job.percent,
            "message": job.message,
            "cancel_requested": job.cancel_requested,
            "created_at": job.created_at,
            "updated_at": job.updated_at,
            "result": result,
        }
        if job.error_code:
            error: dict[str, object] = {
                "code": job.error_code,
                "message": public_job_error(job.error_code),
                "retryable": job.error_code in {"queue_full", "worker_failed", "worker_restarted"},
                "request_id": job.id,
            }
            if os.environ.get("KOVA_VOICE_DEBUG") == "1":
                error["debug_detail"] = job.error_detail
            payload["error"] = error
        return payload

    def create_profile_result(
        context: JobContext,
        *,
        name: str,
        language: str,
        reference_text: str,
        source_path: Path,
        separate_music: bool,
    ) -> tuple[dict[str, object], str]:
        context.update("validate_reference", 12, "validating reference audio")
        blob = source_path.read_bytes()
        safe_name = SAFE_FILENAME.sub("_", source_path.name).strip("._") or "reference.wav"
        context.check_cancelled()
        context.update("prepare_reference", 30, "preparing the selected reference")
        clean_blob, clean_filename = vocal_only_reference(
            blob, safe_name, work_root, separate_music=separate_music
        )
        duration_seconds = reference_duration_seconds(clean_blob)
        if duration_seconds < MIN_REFERENCE_SECONDS or duration_seconds > MAX_REFERENCE_SECONDS:
            raise ValueError(
                f"reference audio must be between {MIN_REFERENCE_SECONDS:g} and {MAX_REFERENCE_SECONDS:g} seconds"
            )
        digest = hashlib.sha256(clean_blob).hexdigest()
        context.check_cancelled()
        context.update("store_reference", 58, "saving worker-owned reference")
        profile, version = store.create_profile(
            name=name,
            language=language,
            reference_filename=clean_filename,
            reference_sha256=digest,
            reference_path="",
            reference_duration_seconds=duration_seconds,
            reference_text=reference_text,
            consent=True,
            engine="omnivoice",
            engine_version=os.environ.get("KOVA_OMNIVOICE_MODEL", "k2-fsa/OmniVoice"),
        )
        reference_path = work_root / "references" / profile.id / version.id / clean_filename
        temporary_path = reference_path.with_suffix(reference_path.suffix + ".part")
        try:
            reference_path.parent.mkdir(parents=True, exist_ok=True)
            temporary_path.write_bytes(clean_blob)
            temporary_path.replace(reference_path)
            store.set_reference_path(version.id, str(reference_path))
            version = store.latest_version(profile.id)
            assert version is not None
            context.check_cancelled()
            if os.environ.get("KOVA_VOICE_PREPARE_PROFILE_PROMPT", "0") == "1":
                context.update("prepare_prompt", 78, "preparing OmniVoice clone prompt")
                engine.prepare_voice_clone_prompt(
                    profile_id=profile.id,
                    reference_audio=version.reference_path,
                    reference_text=version.reference_text,
                    language=profile.language,
                )
            context.update("complete_profile", 96, "profile is ready")
            # A cancellation can arrive while the prompt is being prepared. Check
            # once more before exposing the profile; the exception cleanup below
            # removes both metadata and the worker-owned reference.
            context.check_cancelled()
        except Exception:
            temporary_path.unlink(missing_ok=True)
            reference_path.unlink(missing_ok=True)
            for owned_path in store.delete_profile(profile.id):
                Path(owned_path).unlink(missing_ok=True)
            engine.drop_voice_clone_prompt(profile.id)
            raise
        finally:
            source_path.unlink(missing_ok=True)
        profile_payload = profile.__dict__ | {
            "reference_clean": separate_music,
            "reference_processing": "demucs_cuda_vocals" if separate_music else "none",
            "voice_clone_prompt_ready": engine.has_voice_clone_prompt(profile.id),
        }
        return {"id": profile.id, "profile": profile_payload, "version": safe_version(version)}, ""

    @app.get("/health", dependencies=[Depends(require_token)])
    @app.get("/v1/health", dependencies=[Depends(require_token)])
    def health() -> dict[str, object]:
        return health_payload()

    @app.get("/v1/capabilities", dependencies=[Depends(require_token)])
    def capabilities() -> dict[str, object]:
        return {
            "engine": "omnivoice",
            "profile_versions": True,
            "reference_audio_min_seconds": MIN_REFERENCE_SECONDS,
            "reference_audio_recommended_seconds": 10,
            "reference_audio_max_seconds": MAX_REFERENCE_SECONDS,
            "sample_rate_hz": 24000,
            "formats": ["wav", "mp3", "flac"],
            "reference_vocal_separation": True,
            "auto_reference_transcript": transcription_available(),
        }

    @app.post("/v2/jobs/profile", status_code=202, dependencies=[Depends(require_token)])
    def create_profile_job(
        name: str = Form(...),
        consent_confirmed: bool = Form(False),
        ref_text: str = Form(""),
        language: str = Form("vi"),
        separate_music: bool = Form(False),
        ref_audio: UploadFile = File(...),
    ) -> dict[str, object]:
        if not consent_confirmed:
            raise HTTPException(status_code=422, detail="voice consent is required")
        reference_text = " ".join(ref_text.split())
        if not reference_text or len(reference_text) > 2_000:
            raise HTTPException(status_code=422, detail="an exact reference transcript of at most 2,000 characters is required")
        source = stage_upload(ref_audio, work_root / "uploads")

        def handler(context: JobContext) -> tuple[dict[str, object], str]:
            return create_profile_result(
                context,
                name=name,
                language=language,
                reference_text=reference_text,
                source_path=source,
                separate_music=separate_music,
            )

        job = jobs.submit("profile", "reference upload is waiting for the GPU", handler)
        if job.status == "failed":
            source.unlink(missing_ok=True)
            raise HTTPException(status_code=429, detail="the Colab GPU queue is full; retry after a task finishes")
        return job_payload(job)

    @app.post("/v2/jobs/transcription", status_code=202, dependencies=[Depends(require_token)])
    def transcribe_reference_job(
        language: str = Form("vi"), ref_audio: UploadFile = File(...)
    ) -> dict[str, object]:
        source = stage_upload(ref_audio, work_root / "uploads")

        def handler(context: JobContext) -> tuple[dict[str, object], str]:
            try:
                context.update("transcribe", 35, "transcribing the selected reference")
                context.check_cancelled()
                transcript = auto_transcribe_reference(source.read_bytes(), source.name, language)
                context.check_cancelled()
                return {"text": transcript}, ""
            finally:
                source.unlink(missing_ok=True)

        job = jobs.submit("transcription", "transcription is waiting for the GPU", handler)
        if job.status == "failed":
            source.unlink(missing_ok=True)
            raise HTTPException(status_code=429, detail="the Colab GPU queue is full; retry after a task finishes")
        return job_payload(job)

    @app.post("/v2/jobs/generation", status_code=202, dependencies=[Depends(require_token)])
    def generate_job(request: GenerationJobRequest) -> dict[str, object]:
        version = store.latest_version(request.profile_id)
        if version is None or not version.reference_path or not Path(version.reference_path).is_file():
            raise HTTPException(status_code=404, detail="voice profile reference was not found")

        def handler(context: JobContext) -> tuple[dict[str, object], str]:
            context.update("generate", 35, "OmniVoice is generating audio")
            context.check_cancelled()
            audio = engine.synthesize(
                text=request.text.strip(),
                reference_audio=version.reference_path,
                reference_text=version.reference_text,
                profile_id=request.profile_id,
                language=request.language,
                instruct="",
                speed=request.speed,
                duration=request.duration,
                num_steps=request.num_step,
            )
            context.check_cancelled()
            context.update("save_audio", 88, "saving generated audio")
            result_dir = work_root / "jobs"
            result_dir.mkdir(parents=True, exist_ok=True)
            result_path = result_dir / f"{context.job_id}.wav"
            temporary_path = result_path.with_suffix(".wav.part")
            temporary_path.write_bytes(audio)
            temporary_path.replace(result_path)
            return {"media_type": "audio/wav", "size_bytes": len(audio)}, str(result_path)

        job = jobs.submit("generation", "generation is waiting for the GPU", handler)
        if job.status == "failed":
            raise HTTPException(status_code=429, detail="the Colab GPU queue is full; retry after a task finishes")
        return job_payload(job)

    @app.get("/v2/jobs/{job_id}", dependencies=[Depends(require_token)])
    def job_status(job_id: str) -> dict[str, object]:
        job = store.get_job(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="job was not found")
        return job_payload(job)

    @app.delete("/v2/jobs/{job_id}", dependencies=[Depends(require_token)])
    def cancel_job(job_id: str) -> dict[str, object]:
        try:
            job = jobs.cancel(job_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="job was not found") from error
        return job_payload(job)

    @app.get("/v2/jobs/{job_id}/audio", dependencies=[Depends(require_token)])
    def job_audio(job_id: str) -> FileResponse:
        job = store.get_job(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="job was not found")
        if job.status != "succeeded" or not job.result_path or not Path(job.result_path).is_file():
            raise HTTPException(status_code=409, detail="job audio is not ready")
        return FileResponse(job.result_path, media_type="audio/wav", filename="kova-generated.wav")

    @app.get("/v1/pairing/{code}")
    def claim_desktop_pairing(code: str) -> dict[str, str]:
        """Exchange a one-time notebook code for the in-memory bearer token.

        The custom protocol URL contains the public worker URL and this opaque
        code, never the bearer token. A code can be claimed once only, so it
        cannot be replayed from browser history after the desktop receives it.
        """
        nonlocal pairing_claimed
        expected_code = os.environ.get("KOVA_VOICE_PAIR_CODE", "")
        token = os.environ.get("KOVA_VOICE_API_TOKEN", "")
        if not expected_code or not token or not secrets.compare_digest(code, expected_code):
            raise HTTPException(status_code=404, detail="pairing link is invalid or expired")
        with pairing_lock:
            if pairing_claimed:
                raise HTTPException(status_code=410, detail="pairing link was already used")
            pairing_claimed = True
        return {"token": token}

    @app.get("/v1/profiles", dependencies=[Depends(require_token)])
    def profiles() -> list[dict[str, object]]:
        return [profile.__dict__ for profile in store.list_profiles()]

    @app.get("/v1/profiles/{profile_id}", dependencies=[Depends(require_token)])
    def profile_detail(profile_id: str) -> dict[str, object]:
        profile = store.get_profile(profile_id)
        version = store.latest_version(profile_id)
        if profile is None or version is None:
            raise HTTPException(status_code=404, detail="voice profile was not found")
        return {"profile": profile.__dict__, "version": safe_version(version)}

    @app.get("/v1/profiles/{profile_id}/reference", dependencies=[Depends(require_token)])
    def profile_reference(profile_id: str) -> FileResponse:
        """Return the consented reference only to the authenticated owner.

        KOVA uses this endpoint once to back up a profile created by an older
        desktop build. The worker never exposes reference paths in JSON.
        """
        profile = store.get_profile(profile_id)
        version = store.latest_version(profile_id)
        if profile is None or version is None:
            raise HTTPException(status_code=404, detail="voice profile was not found")
        reference_path = Path(version.reference_path)
        if not version.reference_path or not reference_path.is_file():
            raise HTTPException(status_code=404, detail="profile reference audio is unavailable")
        return FileResponse(
            path=reference_path,
            filename=version.reference_filename,
            media_type="application/octet-stream",
        )

    @app.delete("/v1/profiles/{profile_id}", dependencies=[Depends(require_token)])
    def delete_profile(profile_id: str) -> dict[str, object]:
        try:
            references = store.delete_profile(profile_id)
        except KeyError as error:
            raise HTTPException(status_code=404, detail="voice profile was not found") from error
        engine.drop_voice_clone_prompt(profile_id)
        for reference in references:
            reference_path = Path(reference)
            try:
                if reference_path.is_file():
                    reference_path.unlink()
                parent = reference_path.parent
                # Only remove folders below the worker's own references root.
                if parent.name and parent.parent.name == "references":
                    parent.rmdir()
            except OSError:
                pass
        return {"deleted": True, "id": profile_id}

    @app.post("/v1/profiles", status_code=201, dependencies=[Depends(require_token)])
    def create_profile_json(request: CreateProfileRequest) -> dict[str, object]:
        try:
            profile, version = store.create_profile(**request.model_dump())
        except ValueError as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        return {"profile": profile.__dict__, "version": safe_version(version)}

    @app.post("/profiles", status_code=201, dependencies=[Depends(require_token)])
    async def create_profile_upload(
        name: str = Form(...),
        consent_confirmed: bool = Form(False),
        ref_text: str = Form(""),
        language: str = Form("vi"),
        separate_music: bool = Form(False),
        ref_audio: UploadFile = File(...),
    ) -> dict[str, object]:
        if not consent_confirmed:
            raise HTTPException(status_code=422, detail="voice consent is required")
        ref_text = " ".join(ref_text.split())
        if not ref_text or len(ref_text) > 2_000:
            raise HTTPException(status_code=422, detail="an exact reference transcript of at most 2,000 characters is required")
        safe_name = SAFE_FILENAME.sub("_", Path(ref_audio.filename or "reference.wav").name).strip("._") or "reference.wav"
        if Path(safe_name).suffix.lower() not in {".wav", ".mp3", ".flac"}:
            raise HTTPException(status_code=422, detail="reference audio must be WAV, MP3, or FLAC")
        blob = await ref_audio.read(MAX_REFERENCE_BYTES + 1)
        if not blob or len(blob) > MAX_REFERENCE_BYTES:
            raise HTTPException(status_code=413, detail="reference audio is empty or exceeds the upload limit")
        # When the owner opts into the CUDA Demucs pass, refuse a failed split
        # rather than silently cloning a music-contaminated reference.
        try:
            clean_blob, clean_filename = vocal_only_reference(
                blob, safe_name, path.parent, separate_music=separate_music
            )
        except RuntimeError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        duration_seconds = reference_duration_seconds(clean_blob)
        if duration_seconds < MIN_REFERENCE_SECONDS or duration_seconds > MAX_REFERENCE_SECONDS:
            raise HTTPException(
                status_code=422,
                detail=f"reference audio must be between {MIN_REFERENCE_SECONDS:g} and {MAX_REFERENCE_SECONDS:g} seconds",
            )
        digest = hashlib.sha256(clean_blob).hexdigest()
        profile, version = store.create_profile(
            name=name,
            language=language,
            reference_filename=clean_filename,
            reference_sha256=digest,
            consent=True,
            reference_path="",
            reference_duration_seconds=duration_seconds,
            reference_text=ref_text,
            engine="omnivoice",
            engine_version=os.environ.get("KOVA_OMNIVOICE_MODEL", "k2-fsa/OmniVoice"),
        )
        reference_path = path.parent / "references" / profile.id / version.id / clean_filename
        reference_path.parent.mkdir(parents=True, exist_ok=True)
        reference_path.write_bytes(clean_blob)
        # Reference data remains owned by Voice Studio. Only its opaque profile
        # ID and version are ever returned to KOVA.
        store.set_reference_path(version.id, str(reference_path))
        version = store.latest_version(profile.id)
        assert version is not None
        # The shipped notebook turns this on. Lightweight API tests and local
        # metadata work can opt out; synthesis will still build the prompt once
        # and cache it before the first audio is generated.
        prompt_ready = False
        if os.environ.get("KOVA_VOICE_PREPARE_PROFILE_PROMPT", "0") == "1":
            try:
                engine.prepare_voice_clone_prompt(
                    profile_id=profile.id, reference_audio=version.reference_path,
                    reference_text=version.reference_text, language=profile.language,
                )
                prompt_ready = True
            except Exception as error:
                for owned_path in store.delete_profile(profile.id):
                    try:
                        Path(owned_path).unlink(missing_ok=True)
                    except OSError:
                        pass
                raise HTTPException(status_code=503, detail=f"OmniVoice could not prepare the voice clone prompt: {type(error).__name__}") from error
        profile_payload = profile.__dict__ | {
            "reference_clean": separate_music,
            # An explicit marker lets the desktop make the safety property
            # visible: OmniVoice receives the vocal stem, never the uploaded
            # music mix. This is metadata only; no source audio is exposed.
            "reference_processing": "demucs_cuda_vocals" if separate_music else "none",
            "voice_clone_prompt_ready": prompt_ready,
        }
        return {"id": profile.id, "profile": profile_payload, "version": safe_version(version)}

    @app.post("/transcribe-reference", dependencies=[Depends(require_token)])
    async def transcribe_reference(
        language: str = Form("vi"),
        ref_audio: UploadFile = File(...),
    ) -> dict[str, str]:
        """Return an editable transcript draft for the selected reference only.

        This route neither writes a profile nor substitutes a draft into a
        clone. The desktop requires an explicit user review confirmation before
        it can submit the transcript at profile creation.
        """
        safe_name = SAFE_FILENAME.sub("_", Path(ref_audio.filename or "reference.wav").name).strip("._") or "reference.wav"
        if Path(safe_name).suffix.lower() not in {".wav", ".mp3", ".flac"}:
            raise HTTPException(status_code=422, detail="reference audio must be WAV, MP3, or FLAC")
        blob = await ref_audio.read(MAX_REFERENCE_BYTES + 1)
        if not blob or len(blob) > MAX_REFERENCE_BYTES:
            raise HTTPException(status_code=413, detail="reference audio is empty or exceeds the upload limit")
        try:
            transcript = auto_transcribe_reference(blob, safe_name, language)
        except RuntimeError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        return {"text": transcript}

    @app.get("/v1/voices", dependencies=[Depends(require_token)])
    def voices(status: str = "ready") -> list[dict[str, object]]:
        if status != "ready":
            return []
        return [
            {"id": profile.id, "name": profile.name, "language": profile.language, "status": profile.status}
            for profile in store.list_profiles()
            if profile.status == "ready"
        ]

    @app.post("/generate", dependencies=[Depends(require_token)])
    async def generate(
        text: str = Form(...),
        profile_id: str = Form(...),
        ref_text: str = Form(""),
        instruct: str = Form(""),
        language: str = Form("vi"),
        speed: float = Form(1.0),
        num_step: int = Form(32),
        duration: float | None = Form(None),
        output_format: str = Form("wav"),
    ) -> Response:
        if output_format.lower() != "wav":
            raise HTTPException(status_code=422, detail="only WAV output is currently supported")
        if not text.strip() or len(text) > 10_000:
            raise HTTPException(status_code=422, detail="text is required and must not exceed 10000 characters")
        if speed <= 0 or speed > 2.0 or num_step < 1 or num_step > 64 or (duration is not None and duration <= 0) or len(instruct.strip()) > 500:
            raise HTTPException(status_code=422, detail="invalid synthesis settings")
        version = store.latest_version(profile_id)
        if version is None or not version.reference_path or not Path(version.reference_path).is_file():
            raise HTTPException(status_code=404, detail="voice profile reference was not found")
        try:
            audio = engine.synthesize(
                text=text.strip(), reference_audio=version.reference_path, reference_text=version.reference_text,
                profile_id=profile_id, language=language, instruct=instruct,
                speed=speed, duration=duration, num_steps=num_step,
            )
        except ValueError as error:
            detail = str(error).strip()
            if "empty after silence removal" in detail.lower():
                detail = "the reference clip becomes silent after preprocessing; select a spoken 3–10 second region and try again"
            raise HTTPException(status_code=422, detail=f"OmniVoice rejected the reference or script: {detail[:500]}") from error
        except Exception as error:
            raise HTTPException(status_code=503, detail=f"OmniVoice generation failed: {type(error).__name__}") from error
        return Response(content=audio, media_type="audio/wav", headers={"Cache-Control": "no-store"})

    # Voice Studio is a separate product, not a hidden KOVA settings panel.
    # Its lightweight local UI is intentionally served by the same worker so
    # the profile library works both in development and when the service is
    # deployed to a user-controlled Colab runtime. The bearer token stays in
    # browser memory; the UI never writes it to a project, cookie, or disk.
    ui_root = Path(__file__).resolve().parents[2] / "static"
    app.mount("/", StaticFiles(directory=ui_root, html=True), name="voice_studio_ui")
    return app


def safe_version(version: object) -> dict[str, object]:
    values = version.__dict__.copy()  # type: ignore[attr-defined]
    values.pop("reference_path", None)
    return values


def reference_duration_seconds(blob: bytes) -> float:
    """Decode the uploaded reference before persisting it.

    `soundfile` is also required by the actual OmniVoice worker, so this check
    ensures a profile cannot be created from arbitrary bytes that would fail
    only much later during cloning.
    """
    try:
        import soundfile as sound_file
    except ImportError:
        # A WAV-only standard-library fallback keeps the upload API usable
        # while a minimal local worker is being diagnosed. Colab installs
        # soundfile and continues to validate MP3/FLAC through it.
        try:
            import wave

            with wave.open(BytesIO(blob)) as audio:
                if audio.getframerate() <= 0 or audio.getnframes() <= 0:
                    raise ValueError("reference audio has no samples")
                return float(audio.getnframes()) / float(audio.getframerate())
        except Exception as error:
            raise HTTPException(status_code=422, detail="reference audio cannot be decoded") from error
    try:
        with sound_file.SoundFile(BytesIO(blob)) as audio:
            if audio.samplerate <= 0 or audio.frames <= 0:
                raise ValueError("reference audio has no samples")
            return float(audio.frames) / float(audio.samplerate)
    except Exception as error:
        raise HTTPException(status_code=422, detail="reference audio cannot be decoded") from error


def auto_transcribe_reference(blob: bytes, filename: str, language: str) -> str:
    """Run the optional local Whisper draft pass on the selected clip.

    A cached `faster-whisper` model keeps repeated UI requests quick. The
    caller still has to explicitly confirm the resulting text in KOVA before
    it is stored as the profile's conditioning transcript.
    """
    try:
        from faster_whisper import WhisperModel
    except ImportError as error:
        raise RuntimeError("automatic transcript support is not installed in this worker; type the transcript manually or rerun the updated Colab notebook") from error
    requested_language = language.strip().lower()
    if requested_language not in {"vi", "en"}:
        requested_language = "vi"
    device = "cuda" if engine.detect_device() == "cuda" else "cpu"
    compute_type = "float16" if device == "cuda" else "int8"
    model_name = os.environ.get("KOVA_REFERENCE_TRANSCRIBE_MODEL", "small")
    key = (model_name, device)
    with _TRANSCRIBER_LOCK:
        model = _TRANSCRIBERS.get(key)
        if model is None:
            try:
                model = WhisperModel(model_name, device=device, compute_type=compute_type)
            except Exception as error:
                raise RuntimeError(f"could not load automatic transcript model: {type(error).__name__}") from error
            _TRANSCRIBERS[key] = model
    suffix = Path(filename).suffix.lower() or ".wav"
    try:
        with tempfile.TemporaryDirectory(prefix="kova-voice-transcribe-") as temporary:
            source = Path(temporary) / ("reference" + suffix)
            source.write_bytes(blob)
            segments, _ = model.transcribe(
                str(source), language=requested_language, beam_size=5,
                vad_filter=True, condition_on_previous_text=False,
            )
            transcript = " ".join(segment.text.strip() for segment in segments if segment.text.strip())
    except Exception as error:
        raise RuntimeError(f"automatic transcript failed: {type(error).__name__}") from error
    transcript = " ".join(transcript.split())
    if not transcript or len(transcript) > 2_000:
        raise RuntimeError("automatic transcript was empty or too long; type the transcript manually")
    return transcript


def public_job_error(code: str) -> str:
    return {
        "queue_full": "the Colab GPU is busy; wait for a task to finish and retry",
        "worker_restarted": "the Colab worker restarted before this task finished",
        "validation_failed": "the audio or synthesis settings need attention",
        "worker_failed": "the GPU worker could not complete this task",
    }.get(code, "the worker could not complete this task")


def transcription_available() -> bool:
    try:
        import faster_whisper  # noqa: F401
    except ImportError:
        return False
    return True


def stage_upload(upload: UploadFile, directory: Path) -> Path:
    """Stage a multipart upload without reading its full body into RAM."""
    safe_name = SAFE_FILENAME.sub("_", Path(upload.filename or "reference.wav").name).strip("._") or "reference.wav"
    if Path(safe_name).suffix.lower() not in {".wav", ".mp3", ".flac"}:
        raise HTTPException(status_code=422, detail="reference audio must be WAV, MP3, or FLAC")
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / (secrets.token_hex(16) + Path(safe_name).suffix.lower())
    total = 0
    try:
        with destination.open("wb") as output:
            while chunk := upload.file.read(1024 * 1024):
                total += len(chunk)
                if total > MAX_REFERENCE_BYTES:
                    raise HTTPException(status_code=413, detail="reference audio is empty or exceeds the upload limit")
                output.write(chunk)
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    if total == 0:
        destination.unlink(missing_ok=True)
        raise HTTPException(status_code=413, detail="reference audio is empty or exceeds the upload limit")
    return destination


def vocal_only_reference(
    blob: bytes, filename: str, work_root: Path, *, separate_music: bool = False
) -> tuple[bytes, str]:
    """Return a clean voice stem when the CUDA notebook enabled separation.

    The switch is deliberately opt-in per profile so a clean spoken reference
    is not unnecessarily altered. The shipped Colab notebook installs Demucs
    for references that the desktop explicitly marks as containing music.
    """
    if not separate_music:
        return blob, filename
    suffix = Path(filename).suffix.lower() or ".wav"
    try:
        with tempfile.TemporaryDirectory(prefix="kova-voice-separate-", dir=work_root) as temporary:
            root = Path(temporary)
            input_path = root / ("reference" + suffix)
            input_path.write_bytes(blob)
            result = subprocess.run(
                [
                    sys.executable, "-m", "demucs", "-n", "htdemucs", "--two-stems", "vocals",
                    "--device", "cuda", "--out", str(root / "out"), str(input_path),
                ],
                capture_output=True,
                text=True,
                timeout=300,
                check=False,
            )
            vocals = root / "out" / "htdemucs" / input_path.stem / "vocals.wav"
            if result.returncode != 0 or not vocals.is_file() or vocals.stat().st_size == 0:
                detail = (result.stderr or result.stdout or "Demucs did not create vocals.wav")[-2000:]
                raise RuntimeError("CUDA voice/music separation for the clone reference failed: " + detail)
            return vocals.read_bytes(), "voice_reference_vocals.wav"
    except subprocess.TimeoutExpired as error:
        raise RuntimeError("CUDA voice/music separation for the clone reference timed out after 5 minutes") from error
    except OSError as error:
        raise RuntimeError("cannot start CUDA voice/music separation for the clone reference") from error


app = create_app()


def main() -> None:
    import uvicorn

    uvicorn.run("kova_voice_studio.api:app", host="127.0.0.1", port=3920, reload=False)
