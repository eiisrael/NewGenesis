"""Persistent JSON-lines TTS worker for optional NewGenesis local engines.

Copyright (c) 2026 Erick Israel. MIT License.
Third-party engines and model weights retain their own licenses.
"""

from __future__ import annotations

import argparse
import array
import contextlib
import json
import re
import sys
import traceback
import wave
from pathlib import Path


PRESETS = {
    "natural": {"exaggeration": 0.5, "temperature": 0.8, "cfg_weight": 0.5},
    "calm": {"exaggeration": 0.35, "temperature": 0.7, "cfg_weight": 0.55},
    "expressive": {"exaggeration": 0.7, "temperature": 0.85, "cfg_weight": 0.45},
}
KOKORO_VOICES = {"pf_dora", "pm_alex", "pm_santa"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="NewGenesis persistent local TTS worker")
    parser.add_argument("--engine", choices=("kokoro", "piper", "chatterbox"), required=True)
    parser.add_argument("--model", type=Path)
    parser.add_argument("--config", type=Path)
    parser.add_argument("--voices", type=Path)
    parser.add_argument("--source", type=Path)
    return parser.parse_args()


def chunks(text: str, limit: int = 280) -> list[str]:
    sentences = re.findall(r"[^.!?…]+[.!?…]+|[^.!?…]+$", text)
    result: list[str] = []
    current = ""
    for sentence in sentences:
        clean = " ".join(sentence.split())
        candidate = f"{current} {clean}".strip()
        if len(candidate) <= limit:
            current = candidate
            continue
        if current:
            result.append(current)
        while len(clean) > limit:
            split_at = max(clean.rfind(mark, 0, limit + 1) for mark in ("; ", ": ", ", ", " "))
            if split_at < limit // 2:
                split_at = limit
            result.append(clean[:split_at].strip())
            clean = clean[split_at:].strip()
        current = clean
    if current:
        result.append(current)
    return result


class PiperEngine:
    def __init__(self, args: argparse.Namespace) -> None:
        from piper import PiperVoice

        self.voice = PiperVoice.load(args.model.resolve(strict=True), args.config.resolve(strict=True))

    def synthesize(self, request: dict, output: Path) -> None:
        from piper.config import SynthesisConfig

        rate = clamp(float(request.get("rate", 1)), 0.7, 1.6)
        with wave.open(str(output), "wb") as wav_file:
            self.voice.synthesize_wav(request["text"], wav_file, SynthesisConfig(length_scale=1 / rate))


class KokoroEngine:
    def __init__(self, args: argparse.Namespace) -> None:
        import espeakng_loader
        import torch
        from kokoro import KModel, KPipeline
        from phonemizer.backend.espeak.wrapper import EspeakWrapper

        self.torch = torch
        self.voices = args.voices.resolve(strict=True)
        espeakng_loader.make_library_available()
        EspeakWrapper.set_library(espeakng_loader.get_library_path())
        EspeakWrapper.set_data_path(espeakng_loader.get_data_path())
        model = KModel(config=str(args.config.resolve(strict=True)), model=str(args.model.resolve(strict=True)))
        self.pipeline = KPipeline(lang_code="p", model=model)

    def synthesize(self, request: dict, output: Path) -> None:
        import numpy as np
        import soundfile as sf

        voice = request.get("voice") if request.get("voice") in KOKORO_VOICES else "pf_dora"
        voice_path = self.voices / f"{voice}.pt"
        rate = clamp(float(request.get("rate", 1)), 0.7, 1.6)
        # Voice loading can consume Torch RNG state on the first request.
        # Load/cache it before seeding so cold and warm synthesis are equal.
        self.pipeline.load_voice(str(voice_path.resolve(strict=True)))
        self.torch.manual_seed(42)
        pieces = []
        generated = []
        spoken_text = request["text"]
        for part in chunks(spoken_text):
            for result in self.pipeline(part, voice=str(voice_path.resolve(strict=True)), speed=rate):
                audio = getattr(result, "audio", None)
                if audio is None:
                    audio = getattr(result, "output", None)
                if audio is None and isinstance(result, (tuple, list)) and len(result) > 2:
                    audio = result[2]
                if audio is None:
                    continue
                if hasattr(audio, "detach"):
                    audio = audio.detach().cpu().numpy()
                samples = np.asarray(audio, dtype=np.float32).reshape(-1)
                if samples.size:
                    pieces.append(samples)
                    generated.append(samples)
            pieces.append(np.zeros(960, dtype=np.float32))
        if not generated:
            raise RuntimeError("Kokoro não produziu áudio.")
        speech = np.concatenate(generated)
        if speech.size < 800 or not np.isfinite(speech).all() or float(np.sqrt(np.mean(speech**2))) < 1e-5:
            raise RuntimeError("Kokoro produziu áudio inválido ou silencioso.")
        sf.write(str(output), np.concatenate(pieces[:-1]), 24_000, subtype="PCM_16")


class ChatterboxEngine:
    def __init__(self, args: argparse.Namespace) -> None:
        source = args.source.resolve(strict=True)
        if not (source / "chatterbox" / "tts.py").is_file():
            raise RuntimeError("Fonte oficial do Chatterbox pt-BR não foi instalada pelo setup.")
        sys.path.insert(0, str(source))
        import torch
        import torchaudio
        from chatterbox.tts import ChatterboxTTS

        self.torch = torch
        self.torchaudio = torchaudio
        device = "cuda" if torch.cuda.is_available() else "cpu"
        self.model = ChatterboxTTS.from_pretrained(device)

    def synthesize(self, request: dict, output: Path) -> None:
        preset = PRESETS.get(request.get("preset"), PRESETS["natural"])
        pieces = []
        text_chunks = chunks(request["text"])
        for index, part in enumerate(text_chunks):
            waveform = self.model.generate(part, language_id="pt", **preset).detach().cpu()
            pieces.append(waveform)
            if index + 1 < len(text_chunks):
                pieces.append(self.torch.zeros((1, int(self.model.sr * 0.12))))
        if not pieces:
            raise RuntimeError("Chatterbox não produziu áudio.")
        self.torchaudio.save(str(output), self.torch.cat(pieces, dim=1), self.model.sr)


def create_engine(args: argparse.Namespace):
    if args.engine == "piper":
        return PiperEngine(args)
    if args.engine == "kokoro":
        return KokoroEngine(args)
    return ChatterboxEngine(args)


def write_message(value: dict) -> None:
    sys.__stdout__.write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.__stdout__.flush()


def trim_wave_silence(output: Path, threshold: int = 96, keep_leading_ms: int = 15, keep_trailing_ms: int = 55) -> None:
    """Trim only outer PCM16 silence so sentence streaming does not stack pauses."""
    with wave.open(str(output), "rb") as source:
        params = source.getparams()
        frames = source.readframes(params.nframes)
    if params.sampwidth != 2 or not frames or params.nchannels < 1:
        return
    samples = array.array("h")
    samples.frombytes(frames)
    if sys.byteorder != "little":
        samples.byteswap()
    frame_count = len(samples) // params.nchannels
    active = []
    for frame_index in range(frame_count):
        offset = frame_index * params.nchannels
        if max(abs(samples[offset + channel]) for channel in range(params.nchannels)) >= threshold:
            active.append(frame_index)
    if not active:
        raise RuntimeError("O sintetizador produziu somente silêncio.")
    leading = int(params.framerate * keep_leading_ms / 1000)
    trailing = int(params.framerate * keep_trailing_ms / 1000)
    start = max(0, active[0] - leading)
    end = min(frame_count, active[-1] + trailing + 1)
    if start == 0 and end == frame_count:
        return
    trimmed = samples[start * params.nchannels:end * params.nchannels]
    if sys.byteorder != "little":
        trimmed.byteswap()
    with wave.open(str(output), "wb") as target:
        target.setparams(params)
        target.writeframes(trimmed.tobytes())


def validate_request(value: dict) -> tuple[str, Path]:
    request_id = str(value.get("id", ""))[:80]
    text = " ".join(str(value.get("text", "")).split())
    output = Path(str(value.get("output", "")))
    if not request_id or not text or len(text) > 2_000 or not output.is_absolute():
        raise ValueError("Requisição TTS inválida.")
    value["text"] = text
    output.parent.mkdir(parents=True, exist_ok=True)
    return request_id, output


def main() -> int:
    # Node writes JSONL as UTF-8. Windows otherwise inherits a legacy console
    # code page and turns text such as "você" into mojibake before synthesis.
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="strict")
    args = parse_args()
    with contextlib.redirect_stdout(sys.stderr):
        engine = create_engine(args)
    write_message({"type": "ready", "engine": args.engine})
    for line in sys.stdin:
        request_id = "unknown"
        try:
            request = json.loads(line)
            request_id, output = validate_request(request)
            with contextlib.redirect_stdout(sys.stderr):
                engine.synthesize(request, output)
                trim_wave_silence(output)
            write_message({"id": request_id, "ok": True})
        except Exception as error:  # worker boundary: return a bounded error to Node
            traceback.print_exc(file=sys.stderr)
            write_message({"id": request_id, "ok": False, "error": str(error)[-500:]})
    return 0


def clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


if __name__ == "__main__":
    raise SystemExit(main())
