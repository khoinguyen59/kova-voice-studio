# KOVA Voice Studio 1.0.1.9 — self-contained worker report

## Independence correction

KOVA no longer depends on `kova-video-dubbing` for its GPU worker. The complete, tested worker now lives in this repository under `worker/`:

- `worker/src/kova_voice_studio/`: API, profile store, OmniVoice adapter, cached clone prompts, and optional transcript endpoint.
- `worker/notebooks/Kova_Voice_Studio_GPU.ipynb`: Colab launcher that clones `khoinguyen59/kova-voice-studio` at `master` and starts `worker/`.
- `worker/requirements-colab.txt`: pinned FastAPI, OmniVoice support, Demucs, and optional `faster-whisper` draft transcription requirements.
- `worker/tests/`: worker API, storage, and notebook self-containment tests.

The desktop app’s **Open Colab** action now points to the notebook in this repository. The `.exe` is self-contained at source and deployment level: desktop, worker, tests, and notebook are versioned together in one repository. OmniVoice’s large model and CUDA runtime remain outside the executable by design; the user can run the embedded worker on Colab or a compatible local GPU environment.

## Clone quality workflow

1. Select WAV, MP3, or FLAC.
2. Review its horizontal waveform and drag the two handles to select exactly the 3–10 second clip used for cloning. The interface warns when it is too short and recommends one clean speaker in the profile language.
3. Enter **Lời nói chính xác của audio mẫu**, or request an optional `faster-whisper` draft. A draft is never trusted automatically: editing it clears the review checkbox and profile creation requires explicit user confirmation.
4. Save the reviewed transcript with the local profile and send it as `ref_text` whenever KOVA restores or generates from that profile.
5. After confirmation, the embedded worker creates and caches OmniVoice `voice_clone_prompt`; subsequent generation reuses it for stable conditioning.
6. No generated audio is blindly trimmed. There is no echo guard without transcript/timestamp evidence, so legitimate first words cannot be lost.

## Emotion and AI Gateway controls

- The Studio displays the exact supported token list adjacent to the style selector: `[laughter]`, `[sigh]`, `[confirmation-en]`, `[question-en]`, `[question-ah]`, `[question-oh]`, `[question-ei]`, `[question-yi]`, `[surprise-ah]`, `[surprise-oh]`, `[surprise-wa]`, `[surprise-yo]`, `[dissatisfaction-hnn]`.
- Human styles such as Hài hước and Buồn bã are sent through OmniVoice `instruct`, not presented as false undocumented tokens.
- AI Gateway may propose a rewritten script only when requested. It receives the selected style and a strict token allow-list; the user reviews and explicitly applies the proposal.

## Additional fixes

- Speed supports `0.01` increments and direct numeric entry.
- Quality is documented and exposed as decoder steps (16/32/48/64), not a false 0–100 scale.
- Output folder selection is visible from Studio and new audio is written there; otherwise KOVA retains its private local history location.
- Release executable is written directly to `build/`, not `build/bin/`.

## Verification

- `go test ./...` covers desktop state, reviewed transcript validation, worker requests, emotion tokens, and self-contained Colab URL.
- `npm --prefix frontend run build` verifies the UI.
- `PYTHONPATH=worker/src python -m pytest worker/tests -q` covers the embedded worker and asserts that its Colab notebook clones this repository rather than `kova-video-dubbing`.
- The notebook JSON is parsed before release.
- Windows build completed with the release executable at `build/KOVA-Voice-Studio-1.0.1.9.exe` (SHA-256: `F723ED34B62DEC1ADB11580123BCB1D68B10DD9AEE0DC91239299D0080E8969E`).

## Version rule

The previous release was `1.0.1.8`; this independent-worker release is `1.0.1.9`. Per the four-component rule, the next release must be `1.0.2.0`.
