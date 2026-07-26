# KOVA Voice Studio 1.0.1.8 — final clone-quality report

## Requirements completed in the desktop application

1. **Recognized emotion vocabulary next to the emotion input**
   - Studio lists the exact supported OmniVoice non-verbal tokens: `[laughter]`, `[sigh]`, `[confirmation-en]`, `[question-en]`, `[question-ah]`, `[question-oh]`, `[question-ei]`, `[question-yi]`, `[surprise-ah]`, `[surprise-oh]`, `[surprise-wa]`, `[surprise-yo]`, and `[dissatisfaction-hnn]`.
   - The selector maps human styles such as Hài hước and Buồn bã to an OmniVoice `instruct` prompt. These style labels are not falsely represented as undocumented bracket tokens.

2. **AI Gateway emotion editing**
   - The user chooses a style, asks the Gateway to prepare the script, reviews the returned JSON proposal, then explicitly applies it.
   - The Gateway prompt preserves facts and restricts bracket notation to the selected preset’s token allow-list.

3. **Stable, reviewed reference conditioning**
   - Profile creation requires **Lời nói chính xác trong đoạn đã chọn**.
   - **Tạo nháp tự động** is optional. It sends the selected (cropped, when applicable) clip to the user-controlled worker, fills only a draft, and clears the review confirmation.
   - The user must check **Tôi đã nghe, xem và sửa transcript…** before Create Profile is enabled.
   - The reviewed transcript is saved in KOVA’s private profile state, passed as `ref_text` on worker restore and generation, and never silently replaced by fresh automatic transcription.

4. **Horizontal MP3-cutter-style clip selection**
   - KOVA reads the chosen WAV/MP3/FLAC locally, draws a horizontal waveform, and provides draggable start/end handles.
   - Only the selected crop is converted to private PCM WAV and submitted for cloning. The UI warns below three seconds and recommends one speaker, one language, and 3–10 seconds.

5. **No blind output trimming**
   - No generated audio is blindly trimmed. The fix targets incorrect reference conditioning first; an echo guard is intentionally not enabled without transcript/timestamp evidence.

6. **Controls and storage**
   - Reading speed uses `0.01` increments and a numeric input.
   - Quality explains its true meaning: decoding steps 16/32/48/64, not a 0–100 percentage.
   - Studio visibly shows the audio destination and lets the user choose it; generated files persist in that folder or KOVA’s private history folder.

## Worker and Colab implementation

The separate `kova-video-dubbing/voice-studio` worker checkout was updated and tested with these source changes:

- Persist `reference_text` in `ProfileVersion` with an SQLite migration.
- Require a reviewed reference transcript when creating a profile.
- Use stored `version.reference_text`, not a request-time fallback, for every synthesis.
- Create/cache `voice_clone_prompt` by profile ID and generate with that cache plus `instruct`.
- Drop cached prompt when the profile is deleted.
- Add `POST /transcribe-reference`; it returns a `faster-whisper` draft without creating or modifying a profile.
- Add `faster-whisper==1.1.1` to Colab requirements and enable `KOVA_VOICE_PREPARE_PROFILE_PROMPT=1` in the notebook.

The worker repository is independent from this desktop repository. It has **not** been committed or pushed automatically, so the updated notebook/worker must be deployed before automatic transcription, cached prompt reuse, and `instruct` styles become available in Colab. Desktop 1.0.1.8 degrades safely: it still supports manual reviewed transcripts and explains when an older worker lacks the transcription endpoint.

A reversible, verified deployment artifact is included at `worker-patches/kova-video-dubbing-voice-studio-1.0.1.8.patch`; its reverse application check passed against the reviewed worker checkout.

## Verification

- Desktop Go tests: `go test ./...` — passed.
- Desktop TypeScript check: `npm --prefix frontend run typecheck` — passed.
- Worker tests: `python -m pytest tests -q` — 6 passed.
- Worker Python modules compiled and the Colab notebook JSON parsed.
- Packaging rule: release executable is direct in `build/`; no executable remains in `build/bin/`.
- Release artifact: `build/KOVA-Voice-Studio-1.0.1.8.exe`.
- SHA-256: `6EBBAB2FF7DE84BA229B8EE40E38DCFAC85BADBC8EDCB7E058E48CD1EEE51995`.

## Version rule

This is a real subsequent release after `1.0.1.7`, therefore the product version is `1.0.1.8`. The four-part sequence remains enforced: after `1.0.1.9`, the next release must be `1.0.2.0`.
