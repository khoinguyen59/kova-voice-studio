import json
from pathlib import Path


def test_colab_notebook_clones_the_embedded_kova_worker():
    notebook_path = Path(__file__).parents[1] / "notebooks" / "Kova_Voice_Studio_GPU.ipynb"
    notebook = json.loads(notebook_path.read_text(encoding="utf-8"))
    code = "\n".join(
        line for cell in notebook["cells"] if cell["cell_type"] == "code" for line in cell["source"]
    )
    assert "https://github.com/khoinguyen59/kova-voice-studio.git" in code
    assert "WORKSPACE / 'worker'" in code
    assert "kova-video-dubbing" not in code
