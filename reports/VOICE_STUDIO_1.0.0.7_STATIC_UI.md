# KOVA Voice Studio 1.0.0.7 — fixed desktop surface and K icon

## Fixed interaction surface

- All visual transforms, animations and layout transitions are disabled inside the desktop app.
- The top bar is no longer sticky/floating and the decorative fixed background grid is removed.
- Buttons, panels, navigation and cards remain anchored; only their functional state or colour may change.

## Application identity

- Replaced the Wails `W` app icon with the KOVA `K` icon.
- Source artwork: `assets/kova-app-icon.svg`.
- Build artwork: `build/appicon.png`; Wails embeds it into the Windows executable during production build.

## Verification

- Frontend type-check and production bundle.
- Go unit tests.
- Wails Windows production build.
