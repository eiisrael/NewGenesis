"""Optional local TTS worker for NewGenesis.

Copyright (c) 2026 Erick Israel. MIT License.
Third-party engines and model weights retain their own licenses.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


PRESETS = {
    "natural": {"exaggeration": 0.5, "temperature": 0.8, "cfg_weight": 0.5},
    "calm": {"exaggeration": 0.35, "temperature": 0.7, "cfg_weight": 0.55},
    "expressive": {"exaggeration": 0.7, "temperature": 0.85, "cfg_weight": 0.45},
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="NewGenesis optional local TTS worker")
    parser.add_argument("--engine", choices=("chatterbox",), required=True)
    parser.add_argument("--text-file", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--preset", choices=tuple(PRESETS), default="natural")
    parser.add_argument("--source", type=Path, required=True)
    return parser.parse_args()


def chunks(text: str, limit: int = 300) -> list[str]:
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
            split_at = clean.rfind(" ", 0, limit + 1)
            if split_at < 1:
                split_at = limit
            result.append(clean[:split_at].strip())
            clean = clean[split_at:].strip()
        current = clean
    if current:
        result.append(current)
    return result


def synthesize_chatterbox(args: argparse.Namespace, text: str) -> None:
    source = args.source.resolve(strict=True)
    if not source.is_dir() or not (source / "chatterbox" / "tts.py").is_file():
        raise RuntimeError("Fonte oficial do Chatterbox pt-BR não foi instalada pelo setup.")
    sys.path.insert(0, str(source))
    import torch
    import torchaudio
    from chatterbox.tts import ChatterboxTTS

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = ChatterboxTTS.from_pretrained(device)
    preset = PRESETS[args.preset]
    pieces = []
    text_chunks = chunks(text)
    for index, part in enumerate(text_chunks):
        waveform = model.generate(part, language_id="pt", **preset).detach().cpu()
        pieces.append(waveform)
        if index + 1 < len(text_chunks):
            pieces.append(torch.zeros((1, int(model.sr * 0.14))))
    if not pieces:
        raise RuntimeError("Nenhum texto sintetizável foi recebido.")
    output = torch.cat(pieces, dim=1)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    torchaudio.save(str(args.output), output, model.sr)


def main() -> int:
    args = parse_args()
    text = " ".join(args.text_file.read_text(encoding="utf-8").split())
    if not text or len(text) > 2000:
        raise ValueError("O texto deve conter entre 1 e 2000 caracteres.")
    synthesize_chatterbox(args, text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
