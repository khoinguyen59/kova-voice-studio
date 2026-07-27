# KOVA Voice Studio 1.0.2.0 — trim and OmniVoice fix

## Audio sample trimming

- The horizontal waveform now has a native full-file player and a separate **Play selected clip** control. Playback from that control starts at the chosen start point and stops at the chosen end point; the red playhead shows its current position.
- Start and end time fields accept direct editing at `0.01` second precision. The selected clip continues to enforce the three-second minimum where the uploaded file is long enough.
- Pointer dragging now uses its original grab offset rather than re-centering the selection under the mouse. Cropping is paused while the pointer moves and performed after release, avoiding repeated WAV encoding that made the old slider feel stiff.

## 503 diagnosis and correction

The former desktop preset sent phrases such as `natural, clear, conversational` through OmniVoice's `instruct` parameter. OmniVoice treats `instruct` as its strict voice-design vocabulary (speaker attributes such as `male`, `female`, or `low pitch`), not a free-form emotion prompt. It therefore raised `ValueError`, which the worker surfaced as HTTP 503.

The worker now deliberately omits legacy free-form `instruct` values for cloned voices. Emotion remains available through the documented non-verbal tags in the spoken script, prepared by the AI Gateway and reviewed by the user. The worker also:

- builds reusable clone prompts using OmniVoice's documented `ref_audio`/`ref_text` API;
- retries a quiet reference once with `preprocess_prompt=False` if the default silence removal makes it empty;
- returns an actionable HTTP 422 for a rejected reference/script instead of the opaque `503 ... ValueError` message.

## Verification and artifact

- `PYTHONPATH=worker/src python -m pytest worker/tests -q`: 10 passed.
- `npm --prefix frontend run build`: passed.
- `go test ./...`: passed.
- Windows production build: `build/KOVA-Voice-Studio-1.0.2.0.exe`.
- SHA-256: `F583110D36A50FC979EFDB196530FA72AF1AB399E845F2970838DB3EC749F872`.

The executable is directly in `build/`, not `build/bin/`. The next release under KOVA's four-component rule is `1.0.2.1`.
