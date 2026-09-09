"""Local voice processing regressions; uses only the Python standard library."""

import array
from pathlib import Path
import runpy
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import wave


worker = runpy.run_path(str(Path(__file__).resolve().parents[1] / "scripts/voice/tts-server.py"))


class VoiceWorkerTest(unittest.TestCase):
    def test_kokoro_supplied_model_disables_training_before_pipeline(self):
        class Model:
            def __init__(self, **kwargs):
                self.training = True

            def eval(self):
                self.training = False
                return self

        loader = SimpleNamespace(make_library_available=lambda: None, get_library_path=lambda: "library", get_data_path=lambda: "data")
        wrapper = SimpleNamespace(set_library=lambda _: None, set_data_path=lambda _: None)
        modules = {
            "torch": SimpleNamespace(),
            "kokoro": SimpleNamespace(KModel=Model, KPipeline=lambda **kwargs: SimpleNamespace(**kwargs)),
            "espeakng_loader": loader,
            "phonemizer.backend.espeak.wrapper": SimpleNamespace(EspeakWrapper=wrapper),
        }
        with tempfile.TemporaryDirectory() as directory, patch.dict(sys.modules, modules):
            root = Path(directory)
            (root / "model").touch()
            (root / "config").touch()
            engine = worker["KokoroEngine"](SimpleNamespace(model=root / "model", config=root / "config", voices=root))
            self.assertFalse(engine.pipeline.model.training)

    def test_chunks_preserve_numbers_abbreviations_and_punctuation(self):
        text = "A Dra. Ana mediu 3.14 e pagou R$ 1.234,56. A API respondeu."
        self.assertEqual(worker["chunks"](text), [text])
        text = "A Dra. Ana chegou. O Sr. João veio."
        self.assertEqual(worker["chunks"](text, 20), ["A Dra. Ana chegou.", "O Sr. João veio."])
        for limit in (1, 10, 28):
            text = "abcdefghijklmno" * 5
            chunks = worker["chunks"](text, limit)
            self.assertTrue(all(len(chunk) <= limit for chunk in chunks))
            self.assertEqual("".join(chunks), text)

    def test_trim_removes_only_outer_silence_and_preserves_stereo(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "speech.wav"
            frames = [(0, 0)] * 30 + [(0, 800)] * 10 + [(0, 0)] * 10 + [(800, 0)] * 10 + [(0, 0)] * 80
            samples = array.array("h", [value for frame in frames for value in frame])
            if sys.byteorder != "little":
                samples.byteswap()
            with wave.open(str(output), "wb") as target:
                target.setparams((2, 2, 1000, 0, "NONE", "not compressed"))
                target.writeframes(samples.tobytes())
            worker["trim_wave_silence"](output)
            with wave.open(str(output), "rb") as result:
                self.assertEqual(result.getnchannels(), 2)
                self.assertEqual(result.getnframes(), 100)
                self.assertEqual(result.readframes(100), samples.tobytes()[15 * 4:115 * 4])

    def test_silent_wave_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "silence.wav"
            with wave.open(str(output), "wb") as target:
                target.setparams((1, 2, 1000, 0, "NONE", "not compressed"))
                target.writeframes(bytes(100))
            with self.assertRaisesRegex(RuntimeError, "somente silêncio"):
                worker["trim_wave_silence"](output)


if __name__ == "__main__":
    unittest.main()
