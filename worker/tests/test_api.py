from io import BytesIO
from threading import Event
import time
import wave

from fastapi.testclient import TestClient

import kova_voice_studio.api as api_module
from kova_voice_studio.api import create_app


def reference_wav(seconds: int = 3) -> bytes:
    payload = BytesIO()
    with wave.open(payload, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(8_000)
        audio.writeframes(b"\x00\x00" * 8_000 * seconds)
    return payload.getvalue()


def test_profile_upload_requires_consent_validates_audio_and_hides_worker_path(tmp_path):
    client = TestClient(create_app(tmp_path / "voice.db"))
    blocked = client.post(
        "/profiles",
        data={"name": "Voice", "consent_confirmed": "false", "ref_text": "Đây là giọng mẫu."},
        files={"ref_audio": ("voice.wav", reference_wav(), "audio/wav")},
    )
    assert blocked.status_code == 422

    invalid = client.post(
        "/profiles",
        data={"name": "Voice", "consent_confirmed": "true", "ref_text": "Đây là giọng mẫu."},
        files={"ref_audio": ("voice.wav", b"not-a-real-wav", "audio/wav")},
    )
    assert invalid.status_code == 422

    created = client.post(
        "/profiles",
        data={"name": "Voice", "consent_confirmed": "true", "language": "vi", "ref_text": "Đây là giọng mẫu."},
        files={"ref_audio": ("voice.wav", reference_wav(), "audio/wav")},
    )
    assert created.status_code == 201
    body = created.json()
    assert body["id"]
    assert body["version"]["reference_duration_seconds"] == 3
    assert body["version"]["reference_text"] == "Đây là giọng mẫu."
    assert "reference_path" not in body["version"]
    assert client.get("/v1/voices?status=ready").json()[0]["id"] == body["id"]
    detail = client.get(f"/v1/profiles/{body['id']}").json()
    assert detail["profile"]["id"] == body["id"]
    assert "reference_path" not in detail["version"]
    exported = client.get(f"/v1/profiles/{body['id']}/reference")
    assert exported.status_code == 200
    assert exported.content == reference_wav()
    assert "voice.wav" in exported.headers["content-disposition"]
    deleted = client.delete(f"/v1/profiles/{body['id']}")
    assert deleted.status_code == 200
    assert client.get(f"/v1/profiles/{body['id']}").status_code == 404


def test_worker_token_protects_voice_endpoints(monkeypatch, tmp_path):
    monkeypatch.setenv("KOVA_VOICE_API_TOKEN", "worker-secret")
    client = TestClient(create_app(tmp_path / "voice.db"))
    assert client.get("/v1/health").status_code == 401
    assert client.get("/v1/health", headers={"Authorization": "Bearer worker-secret"}).status_code == 200


def test_reference_transcript_draft_does_not_create_or_mutate_a_profile(monkeypatch, tmp_path):
    monkeypatch.setattr("kova_voice_studio.api.auto_transcribe_reference", lambda blob, filename, language: "Bản nháp cần người dùng kiểm tra.")
    client = TestClient(create_app(tmp_path / "voice.db"))
    response = client.post(
        "/transcribe-reference",
        data={"language": "vi"},
        files={"ref_audio": ("voice.wav", reference_wav(), "audio/wav")},
    )
    assert response.status_code == 200
    assert response.json() == {"text": "Bản nháp cần người dùng kiểm tra."}
    assert client.get("/v1/voices?status=ready").json() == []


def test_colab_pairing_code_is_single_use_and_does_not_need_a_bearer_header(monkeypatch, tmp_path):
    monkeypatch.setenv("KOVA_VOICE_API_TOKEN", "worker-secret")
    monkeypatch.setenv("KOVA_VOICE_PAIR_CODE", "x" * 32)
    client = TestClient(create_app(tmp_path / "voice.db"))
    first = client.get("/v1/pairing/" + "x" * 32)
    assert first.status_code == 200
    assert first.json() == {"token": "worker-secret"}
    assert client.get("/v1/pairing/" + "x" * 32).status_code == 410
    assert client.get("/v1/pairing/" + "y" * 32).status_code == 404


def test_independent_voice_studio_ui_is_served_without_loading_a_model(tmp_path):
    client = TestClient(create_app(tmp_path / "voice.db"))
    page = client.get("/")
    assert page.status_code == 200
    assert "KOVA Voice Studio" in page.text


def test_generation_ignores_legacy_freeform_instruct_and_reports_reference_validation(monkeypatch, tmp_path):
    client = TestClient(create_app(tmp_path / "voice.db"))
    created = client.post(
        "/profiles",
        data={"name": "Voice", "consent_confirmed": "true", "language": "vi", "ref_text": "Day la giong mau."},
        files={"ref_audio": ("voice.wav", reference_wav(), "audio/wav")},
    )
    assert created.status_code == 201
    profile_id = created.json()["id"]
    calls: list[dict[str, object]] = []

    def synthesize(**kwargs):
        calls.append(kwargs)
        return reference_wav()

    monkeypatch.setattr(api_module.engine, "synthesize", synthesize)
    generated = client.post(
        "/generate",
        data={"text": "Noi dung moi.", "profile_id": profile_id, "instruct": "natural, clear, conversational", "language": "vi"},
    )
    assert generated.status_code == 200
    assert calls and calls[0]["instruct"] == "natural, clear, conversational"

    def reject_reference(**kwargs):
        raise ValueError("Reference audio is empty after silence removal. Try setting preprocess_prompt=False.")

    monkeypatch.setattr(api_module.engine, "synthesize", reject_reference)
    rejected = client.post("/generate", data={"text": "Noi dung moi.", "profile_id": profile_id})
    assert rejected.status_code == 422
    assert "reference clip becomes silent" in rejected.json()["detail"]


def wait_for_job(client: TestClient, job_id: str) -> dict[str, object]:
    for _ in range(80):
        job = client.get(f"/v2/jobs/{job_id}")
        assert job.status_code == 200
        payload = job.json()
        if payload["status"] in {"succeeded", "failed", "cancelled"}:
            return payload
        time.sleep(0.02)
    raise AssertionError("job did not finish")


def test_v2_jobs_queue_profile_transcription_and_audio(monkeypatch, tmp_path):
    monkeypatch.setattr(
        "kova_voice_studio.api.auto_transcribe_reference",
        lambda blob, filename, language: "Transcript draft.",
    )
    client = TestClient(create_app(tmp_path / "voice.db"))

    transcript_job = client.post(
        "/v2/jobs/transcription",
        data={"language": "vi"},
        files={"ref_audio": ("voice.wav", reference_wav(), "audio/wav")},
    )
    assert transcript_job.status_code == 202
    transcript = wait_for_job(client, transcript_job.json()["id"])
    assert transcript["status"] == "succeeded"
    assert transcript["result"] == {"text": "Transcript draft."}

    profile_job = client.post(
        "/v2/jobs/profile",
        data={"name": "Voice", "consent_confirmed": "true", "language": "vi", "ref_text": "Exact words."},
        files={"ref_audio": ("voice.wav", reference_wav(), "audio/wav")},
    )
    assert profile_job.status_code == 202
    profile = wait_for_job(client, profile_job.json()["id"])
    assert profile["status"] == "succeeded"
    profile_id = profile["result"]["id"]

    monkeypatch.setattr(api_module.engine, "synthesize", lambda **kwargs: reference_wav())
    generation_job = client.post(
        "/v2/jobs/generation",
        json={"text": "New content.", "profile_id": profile_id, "language": "vi", "speed": 1.0, "num_step": 32},
    )
    assert generation_job.status_code == 202
    generated = wait_for_job(client, generation_job.json()["id"])
    assert generated["status"] == "succeeded"
    audio = client.get(f"/v2/jobs/{generation_job.json()['id']}/audio")
    assert audio.status_code == 200
    assert audio.content == reference_wav()


def test_cancelling_a_profile_during_prompt_preparation_removes_it(monkeypatch, tmp_path):
    entered = Event()
    release = Event()

    def prepare_prompt(**kwargs):
        entered.set()
        assert release.wait(timeout=3)

    monkeypatch.setenv("KOVA_VOICE_PREPARE_PROFILE_PROMPT", "1")
    monkeypatch.setattr(api_module.engine, "prepare_voice_clone_prompt", prepare_prompt)
    client = TestClient(create_app(tmp_path / "voice.db"))
    submitted = client.post(
        "/v2/jobs/profile",
        data={"name": "Voice", "consent_confirmed": "true", "language": "vi", "ref_text": "Exact words."},
        files={"ref_audio": ("voice.wav", reference_wav(), "audio/wav")},
    )
    assert submitted.status_code == 202
    job_id = submitted.json()["id"]
    assert entered.wait(timeout=3)
    cancelled = client.delete(f"/v2/jobs/{job_id}")
    assert cancelled.status_code == 200
    release.set()
    job = wait_for_job(client, job_id)
    assert job["status"] == "cancelled"
    assert client.get("/v1/voices?status=ready").json() == []
