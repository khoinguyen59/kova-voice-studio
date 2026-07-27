import sys
from types import SimpleNamespace

import numpy as np

from kova_voice_studio.engine import OmniVoiceEngine


class FakeOmniVoice:
    sampling_rate = 8_000

    def __init__(self, reject_preprocessing: bool = False):
        self.reject_preprocessing = reject_preprocessing
        self.prompt_calls: list[dict[str, object]] = []
        self.generate_kwargs: dict[str, object] | None = None

    def create_voice_clone_prompt(self, **kwargs):
        self.prompt_calls.append(kwargs)
        if self.reject_preprocessing and kwargs.get("preprocess_prompt", True):
            raise ValueError("Reference audio is empty after silence removal. Try setting preprocess_prompt=False.")
        return object()

    def generate(self, **kwargs):
        self.generate_kwargs = kwargs
        return [np.zeros(800, dtype=np.float32)]


def configured_engine(model: FakeOmniVoice) -> OmniVoiceEngine:
    engine = OmniVoiceEngine()
    engine._model = model
    engine._device = "cuda"
    engine._dtype = "float16"
    return engine


def test_quiet_reference_retries_without_silence_removal():
    model = FakeOmniVoice(reject_preprocessing=True)
    engine = configured_engine(model)

    engine.prepare_voice_clone_prompt(
        profile_id="profile", reference_audio="reference.wav", reference_text="exact transcript", language="vi"
    )

    assert len(model.prompt_calls) == 2
    assert model.prompt_calls[0] == {"ref_audio": "reference.wav", "ref_text": "exact transcript"}
    assert model.prompt_calls[1]["preprocess_prompt"] is False


def test_clone_generation_does_not_forward_legacy_freeform_instruct_or_empty_duration(monkeypatch):
    model = FakeOmniVoice()
    engine = configured_engine(model)
    monkeypatch.setitem(sys.modules, "soundfile", SimpleNamespace(write=lambda output, audio, rate, format: output.write(b"RIFFfake")))

    result = engine.synthesize(
        text="Noi dung moi.", reference_audio="reference.wav", reference_text="exact transcript",
        profile_id="profile", language="vi", instruct="natural, clear, conversational",
        speed=1.0, duration=None, num_steps=32,
    )

    assert result.startswith(b"RIFF")
    assert model.generate_kwargs is not None
    assert model.generate_kwargs["num_step"] == 32
    assert "instruct" not in model.generate_kwargs
    assert "duration" not in model.generate_kwargs
