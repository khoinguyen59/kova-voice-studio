# KOVA Voice Studio

KOVA Voice Studio is a standalone Windows desktop app for creating and reusing consented voice-clone profiles. It is intentionally separate from KOVA Video Localization Studio.

## What it does

- Creates a profile from an authorized WAV, MP3, or FLAC reference.
- Preserves the local profile/reference backup so a saved voice can be reused later.
- Connects to a user-controlled OmniVoice GPU worker, including the included Colab workflow.
- Separates speech from music before profile creation on the worker.
- Generates and previews voice audio, with short, medium, and long test scripts.
- Imports TXT, SRT, MD, DOCX, and PDF locally or by a Google Drive sharing link.
- Reviews text through an OpenAI-compatible API Gateway without persisting API keys.
- Lists models reported as zero-cost by an API Gateway and also supports a fully custom API/model configuration.

## Privacy and consent

Only create a voice profile when you have permission to use the reference recording. Reference backups, saved profiles, and generated-audio history are local app data and are intentionally excluded from Git.

## Development

Requirements: Go, Node.js, and the Wails CLI.

```powershell
cd frontend
npm install
npm run build
cd ..
go test ./... -count=1
wails build
```

The published source excludes `data/`, executable builds, Node dependencies, and local caches. The Windows icon template under `build/windows/` remains tracked because it is required for reproducible desktop builds.
