"""Download and verify the official Chatterbox V3 pt-BR assets on explicit request."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
from pathlib import Path

from huggingface_hub import hf_hub_download, snapshot_download


EXPECTED = {
    "t3_pt_br.safetensors": "074aaf65255eb9cb960288f7cc72e09d3b5008f6e0b14868c0d4e5b0bd7cbb6c",
    "s3gen_v3.pt": "f7abce4b196dae2d08d9296cbebc6521b046079577643b42a19a03499d08721e",
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--voice-dir", type=Path, required=True)
    args = parser.parse_args()
    voice_dir = args.voice_dir.resolve()
    voice_dir.mkdir(parents=True, exist_ok=True)
    hf_home = voice_dir / "hf-cache"
    os.environ["HF_HOME"] = str(hf_home)

    source_dir = voice_dir / "chatterbox-space"
    snapshot_download(
        repo_id="ResembleAI/Chatterbox-Multilingual-TTS-pt-br",
        repo_type="space",
        revision="9e515821e826e207cd617a0fdd0223899ed108ea",
        allow_patterns=["chatterbox/**"],
        local_dir=source_dir,
    )
    base_dir = Path(snapshot_download(
        repo_id="ResembleAI/chatterbox",
        revision="main",
        allow_patterns=["ve.pt", "grapheme_mtl_merged_expanded_v1.json", "conds.pt"],
    ))
    installed = {}
    for filename, expected in EXPECTED.items():
        downloaded = Path(hf_hub_download(
            repo_id="ResembleAI/Chatterbox-Multilingual-pt-br",
            revision="main",
            filename=filename,
        ))
        actual = sha256(downloaded)
        if actual != expected:
            raise RuntimeError(f"SHA-256 inválido para {filename}: {actual}")
        destination = base_dir / filename
        if not destination.exists():
            try:
                os.link(downloaded, destination)
            except OSError:
                shutil.copy2(downloaded, destination)
        installed[filename] = {"sha256": actual, "bytes": downloaded.stat().st_size}

    marker = {
        "engine": "chatterbox",
        "model": "ResembleAI/Chatterbox-Multilingual-pt-br",
        "sourceRevision": "9e515821e826e207cd617a0fdd0223899ed108ea",
        "license": "MIT",
        "language": "pt-BR",
        "assets": installed,
    }
    (voice_dir / "chatterbox.ready").write_text(json.dumps(marker, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
