from io import BytesIO
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
