# KOVA Voice Studio

KOVA Voice Studio is a Windows desktop client for creating and reusing consented voice-clone profiles on a user-controlled KOVA Voice Studio GPU worker. It is independent from KOVA Video Localization Studio.

## Run the packaged app

The production executable is written directly to `build/KOVA-Voice-Studio-<version>.exe`; for this release it is `build/KOVA-Voice-Studio-1.0.1.8.exe`. On Windows, open it directly; WebView2 is required (it is normally included with current Windows installations).

## First connection

1. In the app, select **Mở notebook Google Colab**, choose a GPU runtime, then use **Run all**.
2. In the final Colab cell, copy `KOVA_VOICE_URL` and `KOVA_VOICE_TOKEN`.
3. Paste both values into **Kết nối KOVA Voice Studio GPU**, then select **Kiểm tra kết nối**.
4. Create a profile only from an audio recording you are authorized to use. The profile can then be reused in **Phòng thu** without cloning it again.

The published notebook prints the worker URL and session token; it does not call back into the desktop app automatically. Tokens and API keys are session-only and are never written to the local state file.

## Features

- Authorized WAV, MP3, and FLAC profile creation with local reference backup.
- Saved profile restoration after a Colab reset.
- Audio preview and generation with a private local history.
- TXT, SRT, MD, DOCX, PDF, and Google Drive document import.
- Optional OpenAI-compatible Gateway review. Only models with explicit numeric zero pricing are labelled free.
- Native Windows file picker and drag-and-drop support without encoding whole files into the web UI.

## Privacy and storage

Profiles, reference backups, and generated history are local only, under `%APPDATA%\KOVA Voice Studio` by default. Set `KOVA_VOICE_STUDIO_DATA_DIR` to use a different local folder. History is capped at 100 items and unused local artifacts are reconciled on startup.

Only create a voice profile when you have the subject's permission to use the reference recording.

## Development and verification

Requirements: Go 1.24, Node.js 22+, and Wails CLI 2.12+.

```powershell
cd frontend
npm ci
npm run typecheck
npm run build
cd ..
go test ./... -count=1
wails build -clean
```

The packaging hook moves the executable from Wails' temporary `build/bin/` directory to `build/KOVA-Voice-Studio-<version>.exe`. Release versions use four numeric components: after `1.0.1.4` comes `1.0.1.5`; after `1.0.1.9` comes `1.0.2.0` (never `1.0.1.10`). The source excludes user data, build output, Node modules, and local tool caches.
