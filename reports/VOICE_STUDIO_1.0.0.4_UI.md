# KOVA Voice Studio 1.0.0.4 — UI foundation

## Fixed

- Theme now applies to `html`, `body`, `#root`, the full app shell, sidebar, top bar, cards, inputs and background. Light mode no longer leaves a dark left sidebar behind.
- Added a functional **System** appearance option: it follows Windows/browser light preference where supported.
- Light sidebar now uses the same light surface family as the workspace, with readable navigation, privacy card and version text.

## Visual refresh

- Full-window layered gradient and low-contrast dot field rather than a flat right-side background.
- Sticky translucent top bar, more deliberate 22–26 px card geometry, clearer borders and depth.
- Small non-blocking motion on the identity mark, waveform and hero orb; pressed/hover feedback is touch-safe and disables movement at small widths.
- Existing content tools remain visible, but are grouped as an editorial desk rather than a collection of unrelated forms.

## Google Stitch status

- Google Stitch is reachable at `https://stitch.withgoogle.com/` and the sign-in flow opens correctly.
- The current browser session is not authenticated. A Google login is required before Stitch can generate or export a KOVA-specific visual concept.
- No KOVA files, screenshots, audio, API keys or user data were uploaded to Stitch.

## Verification

- `npm run build` (frontend): pass.
- `go test ./... -count=1`: pass.
- Wails production build: pass.
