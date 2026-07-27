# KOVA Voice Studio

KOVA Voice Studio is a self-contained Windows project for creating and reusing consented voice-clone profiles. The desktop app, OmniVoice worker source, worker tests, and Google Colab notebook live in this repository; it does not require the former `kova-video-dubbing` worker repository.

## Run the packaged app

The production executable is written directly to `build/KOVA-Voice-Studio-<version>.exe`; for this release it is `build/KOVA-Voice-Studio-1.0.2.1.exe`. On Windows, open it directly; WebView2 is required (it is normally included with current Windows installations).

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
- Reviewed reference transcript, optional auto-transcription draft, horizontal waveform trimming, and cached OmniVoice conditioning.
- Emotion-style selector, documented OmniVoice token list, and constrained AI Gateway editing.

## Embedded GPU worker

The complete worker is under [`worker/`](worker/). It is versioned and tested with the desktop app in this repository. Its Colab notebook installs OmniVoice, Demucs, and the optional transcription model, then starts a session-only authenticated worker. It is intentionally not bundled into the `.exe`: OmniVoice requires a large model and a CUDA-capable runtime. The repository is self-contained; the user chooses whether that runtime is Google Colab or their own compatible GPU machine.

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
# Commit and push the release source, then create and push the matching tag:
git tag v1.0.2.1
git push origin master --follow-tags
# Only then build the final EXE:
.\scripts\build-release.ps1
```

The packaging hook moves the executable from Wails' temporary `build/bin/` directory to `build/KOVA-Voice-Studio-<version>.exe`. Release versions use four numeric components: after `1.0.1.4` comes `1.0.1.5`; after `1.0.1.9` comes `1.0.2.0` (never `1.0.1.10`). Before a release build, commit and push the exact source revision **and its matching `v<version>` tag** to GitHub; both scripts refuse to build/package when either check is missing. The release notebook then opens that exact tag instead of a moving branch. The source excludes user data, build output, Node modules, and local tool caches.
