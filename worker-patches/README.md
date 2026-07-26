# Worker deployment patch

`kova-video-dubbing-voice-studio-1.0.1.8.patch` contains the tested changes for the separate `kova-video-dubbing` repository.

From the root of that repository, apply and verify it with:

```powershell
git apply C:\path\to\voice-clone-desktop\worker-patches\kova-video-dubbing-voice-studio-1.0.1.8.patch
Set-Location voice-studio
$env:PYTHONPATH = "$PWD\src"
python -m pytest tests -q
```

Then commit/push the worker repository and rerun the updated `voice-studio/notebooks/Kova_Voice_Studio_GPU.ipynb` on Colab. The notebook installs `faster-whisper`, prepares and caches the profile prompt after confirmation, and exposes optional reference transcription.
