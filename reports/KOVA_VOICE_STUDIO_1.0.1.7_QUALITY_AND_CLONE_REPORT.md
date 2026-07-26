# KOVA Voice Studio 1.0.1.7 — quality and clone-conditioning report

## Delivered in the desktop executable

- The profile form now requires the user-reviewed, exact transcript of the selected reference clip. It is saved privately with the profile and is always sent as `ref_text` when the voice is restored or used. KOVA no longer asks the worker to guess the transcript again for each generation.
- The selected source can be decoded locally into a horizontal waveform. Drag the left/right handles to crop the clone reference; only that crop is sent. The UI recommends a single speaker, single language, and 3–10 seconds.
- The crop is encoded as a private WAV under the app data directory, copied into the protected profile backup after confirmation, then removed from the temporary incoming area.
- Studio now has an explicit vocal-style selector. It sends OmniVoice `instruct` text for natural, cheerful, playful, energetic, calm, sad, tender, serious, surprised, questioning, dissatisfied, and confirming delivery.
- The AI Gateway action rewrites only after the user asks. It preserves content and is restricted to the documented OmniVoice token allow-list:
  `[laughter]`, `[sigh]`, `[confirmation-en]`, `[question-en]`, `[question-ah]`, `[question-oh]`, `[question-ei]`, `[question-yi]`, `[surprise-ah]`, `[surprise-oh]`, `[surprise-wa]`, `[surprise-yo]`, `[dissatisfaction-hnn]`.
- Speed now has a `0.01` step and a numeric input. Quality exposes 16, 32, 48, and 64 decoding steps and explains that it is not a percentage; `100` is not an OmniVoice quality setting.
- The Studio output panel now exposes the selected destination folder and a **Choose folder** action. If none is selected, history remains in KOVA’s private folder.

## Quality rationale

The reference transcript is the important correction for the repeated words heard at the beginning of generated audio. OmniVoice uses the transcript to align the reference speaker conditioning. The old behavior allowed a worker-side automatic transcript to differ from the actual clip; it could then condition on incorrect reference text. The new profile field makes the reviewed transcript authoritative.

The worker-side change below uses `create_voice_clone_prompt` once for each saved profile and retains the resulting prompt in the Colab worker process. It then generates using that prompt rather than recreating reference conditioning each time. No blind audio trimming is added.

## Separate worker / Colab deployment required

The GPU worker is maintained in a different repository from this desktop app: `kova-video-dubbing/voice-studio`. The following worker files were updated and their tests passed in a local checkout, but they are not pushed automatically:

- `src/kova_voice_studio/store.py`: persist `reference_text` with a migration.
- `src/kova_voice_studio/api.py`: require the reviewed transcript, use it as the authoritative generation reference, accept `instruct`, prepare/drop cached profile prompts.
- `src/kova_voice_studio/engine.py`: cache `voice_clone_prompt` by profile ID and generate with `voice_clone_prompt` plus `instruct`.
- `notebooks/Kova_Voice_Studio_GPU.ipynb`: set `KOVA_VOICE_PREPARE_PROFILE_PROMPT=1` so the prompt is prepared after profile confirmation.
- `tests/test_api.py` and `tests/test_store.py`: cover persisted reviewed transcripts.

Until those worker changes are committed and the Colab notebook is re-run, desktop 1.0.1.7 still sends the correct persisted `ref_text` to the existing worker, but worker prompt caching and tone instructions will not be active there.

## Validation

- `go test ./...` — passed.
- `npm --prefix frontend run build` — passed.
- Worker `python -m pytest tests -q` — 5 passed.
- Worker Python modules and the Colab notebook JSON — parsed successfully.
- Release executable: `build/KOVA-Voice-Studio-1.0.1.7.exe`.
- SHA-256: `E7B582F101AC1B8E250945A154EA895BB5C1C60A2FC5A961DF6F013B1DBB8FE9`.

## Packaging and versioning

The release follows the four-part sequence: `1.0.1.6` → `1.0.1.7`. The executable is directly in `build/`; it is not left in `build/bin/`.
