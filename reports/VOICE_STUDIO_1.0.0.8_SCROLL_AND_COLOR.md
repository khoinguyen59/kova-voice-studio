# KOVA Voice Studio 1.0.0.8 — bounded scrolling and blue/cyan identity

## Scrolling

- The desktop shell is constrained to the window viewport.
- Only the main content and sidebar are scroll containers.
- `overscroll-behavior` and `-ms-scroll-chaining` are disabled at every scroll boundary, preventing the WebView from stretching the page and exposing an empty gap when the user drags past the top or bottom.
- Small-window/mobile rules retain normal document scrolling.

## Colour and icon

- Replaced the purple accent palette with blue-to-cyan gradients.
- Updated the brand mark, primary actions, waveform, hero accent and Windows application icon.
- The KOVA `K` remains white for legibility on the blue/cyan icon surface.

## Verification

- Frontend production build.
- Go unit tests.
- Wails Windows production build.
- Extracted the icon from the final executable for verification.
