# KOVA Voice Studio

KOVA Voice Studio is the embedded, consent-aware voice-cloning service for
this repository. It can run locally for development or as the GPU worker in
Google Colab. The desktop application selects an opaque, ready profile ID;
it never stores worker profile paths or session tokens in project state.

It also serves its own bilingual profile-library UI at `/`. This is a separate
Voice Studio surface for creating and reviewing consented profiles; KOVA
Desktop integrates it only by loading ready, opaque profile IDs. The worker
token is kept in the browser page memory and is not stored by that UI.

## Safety and consistency contract

- Creating a profile requires explicit consent.
- Reference audio is decoded before storage and must be WAV, MP3, or FLAC,
  between 3 and 30 seconds (10 seconds is recommended).
- Every initial profile gets immutable version `1`. The profile version records
  hash, engine and reference duration; its local reference path is never in an
  API response.
- KOVA reuses an opaque saved profile ID for every generation. It does not
  upload a new reference clip per cue, preventing accidental voice drift.
- Music/vocal separation is opt-in (`separate_music=true`). A clean spoken
  reference should not be processed by Demucs; use it only for recordings with
  music or heavy background sound.
- Set `KOVA_VOICE_API_TOKEN` for a Colab worker. KOVA sends it only as a bearer
  header kept in runtime memory.

## API

```text
GET  /health
GET  /v1/health
GET  /v1/capabilities
GET  /v1/profiles
GET  /v1/profiles/{profile_id}
POST /v1/profiles               JSON metadata contract
POST /profiles                  consented multipart reference upload
POST /transcribe-reference      optional editable transcript draft
GET  /v1/voices?status=ready    KOVA dropdown source
POST /generate                  multipart synthesis for profile:<id>
GET  /v1/pairing/{one-time-code} one-click desktop pairing

POST /v2/jobs/profile            queued multipart profile creation
POST /v2/jobs/transcription      queued transcript draft
POST /v2/jobs/generation         queued synthesis
GET  /v2/jobs/{job_id}           durable job status/error
DELETE /v2/jobs/{job_id}         request cancellation
GET  /v2/jobs/{job_id}/audio     completed generation audio
```

## One-click Colab pairing

Open KOVA Voice Studio first, then run the shipped Colab notebook. Its final
cell shows **Kết nối KOVA Voice Studio**. Clicking it passes only the worker
URL and a one-time opaque code to the desktop through `kova-voice-studio://`.
The desktop exchanges that code over HTTPS for the bearer token, verifies the
GPU worker, and keeps the token only in the current app session. Manual URL
and token inputs remain available as a fallback.

OmniVoice loads lazily on the first GPU job. A CUDA health response means the
worker is ready to accept work even while `ready=false`; health/profile routes
never load a model or start inference. To run inference on Colab, use
[`notebooks/Kova_Voice_Studio_GPU.ipynb`](notebooks/Kova_Voice_Studio_GPU.ipynb),
select a GPU runtime, run all cells, then paste its printed URL and token into
KOVA Desktop's **Giọng lồng tiếng cố định / Fixed dubbing voice** stage.

## Development checks

```powershell
$env:PYTHONPATH = "src"
python -m pytest -q tests
```

These tests exercise profile consent, token authentication, API privacy, and
audio decoding only. They do not load OmniVoice or invoke a GPU.
