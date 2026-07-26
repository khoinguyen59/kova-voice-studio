"""Lazy OmniVoice adapter; importing this module never starts a GPU task."""

from __future__ import annotations

from io import BytesIO
import os
from pathlib import Path
from threading import Lock
from typing import Any


class OmniVoiceEngine:
    def __init__(self) -> None:
        self._model: Any | None = None
        self._lock = Lock()
        self._device = "unconfigured"
        self._dtype = "unconfigured"
        # Prompt tensors are process-local by design: they are derived only from
        # the consented worker-owned reference and can be rebuilt after a Colab
        # reset. This prevents Whisper from being run on every generation.
        self._voice_clone_prompts: dict[str, Any] = {}

    @property
    def device(self) -> str:
        if self._model is not None:
            return self._device
        return self.detect_device()

    @property
    def dtype(self) -> str:
        if self._model is not None:
            return self._dtype
        return "float16" if self.detect_device() == "cuda" else "float32"

    def ready(self) -> bool:
        return self._model is not None

    @staticmethod
    def detect_device() -> str:
        """Report capability without constructing a model or starting inference."""
        try:
            import torch

            return "cuda" if torch.cuda.is_available() else "cpu"
        except Exception:
            return "unavailable"

    def load(self) -> None:
        if self._model is not None:
            return
        with self._lock:
            if self._model is not None:
                return
            import torch
            from omnivoice import OmniVoice

            require_cuda = os.environ.get("KOVA_VOICE_REQUIRE_CUDA", "0") == "1"
            if torch.cuda.is_available():
                self._device, self._dtype = "cuda", "float16"
                dtype = torch.float16
            elif require_cuda:
                raise RuntimeError("CUDA is required by this Voice Studio worker")
            else:
                self._device, self._dtype = "cpu", "float32"
                dtype = torch.float32
            model_id = os.environ.get("KOVA_OMNIVOICE_MODEL", "k2-fsa/OmniVoice")
            self._model = OmniVoice.from_pretrained(model_id, device_map=self._device, dtype=dtype)

    def prepare_voice_clone_prompt(
        self, *, profile_id: str, reference_audio: str, reference_text: str, language: str
    ) -> None:
        if not reference_text.strip():
            raise ValueError("an exact reference transcript is required for voice cloning")
        self.load()
        assert self._model is not None
        with self._lock:
            if profile_id in self._voice_clone_prompts:
                return
            try:
                prompt = self._model.create_voice_clone_prompt(
                    ref_audio=reference_audio, ref_text=reference_text, language=language or None
                )
            except TypeError:
                # OmniVoice releases before language conditioning accepted the same
                # prompt builder but without `language`.
                prompt = self._model.create_voice_clone_prompt(ref_audio=reference_audio, ref_text=reference_text)
            self._voice_clone_prompts[profile_id] = prompt

    def drop_voice_clone_prompt(self, profile_id: str) -> None:
        with self._lock:
            self._voice_clone_prompts.pop(profile_id, None)

    def synthesize(
        self,
        *,
        text: str,
        reference_audio: str,
        reference_text: str,
        profile_id: str,
        language: str,
        instruct: str,
        speed: float,
        duration: float | None,
        num_steps: int,
    ) -> bytes:
        self.load()
        assert self._model is not None
        import soundfile as sound_file

        self.prepare_voice_clone_prompt(
            profile_id=profile_id, reference_audio=reference_audio,
            reference_text=reference_text, language=language,
        )
        prompt = self._voice_clone_prompts[profile_id]
        kwargs: dict[str, Any] = {
            "text": text, "voice_clone_prompt": prompt, "language": language or None,
            "speed": speed, "duration": duration, "num_step": num_steps,
        }
        if instruct.strip():
            kwargs["instruct"] = instruct.strip()
        try:
            audio = self._model.generate(**kwargs)
        except TypeError as error:
            # A clear error is safer than silently discarding a requested style.
            if instruct.strip() and "instruct" in str(error):
                raise RuntimeError("this OmniVoice version does not support vocal-style instructions; update the Colab OmniVoice package") from error
            raise
        if not audio:
            raise RuntimeError("OmniVoice returned no audio")
        output = BytesIO()
        sound_file.write(output, audio[0], self._model.sampling_rate, format="WAV")
        return output.getvalue()


engine = OmniVoiceEngine()
