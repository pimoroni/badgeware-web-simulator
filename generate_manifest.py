#!/usr/bin/env python3
"""Regenerate simulator/fonts-manifest.json for the Font Explorer.

A static site can't list a directory, so the explorer (fonts.html) reads the set
of fonts to load from a manifest. The fonts themselves are NOT vendored for the
explorer -- it loads the exact files the simulator ships, straight from the
emulated filesystem. Run this whenever you add or remove font files:

    ./generate_manifest.py

Scans the simulator's font directories (relative to this script, so it works from
any working directory) and writes a sorted manifest:

    vector (.af)  <- simulator/filesystem/system/assets/fonts
    pixel  (.ppf) <- simulator/filesystem/rom/fonts
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FILESYSTEM = ROOT / "simulator" / "filesystem"

SOURCES = {
    "vector": (FILESYSTEM / "system" / "assets" / "fonts", ".af"),
    "pixel": (FILESYSTEM / "rom" / "fonts", ".ppf"),
}

OUT = ROOT / "simulator" / "fonts-manifest.json"


def collect(directory: Path, ext: str) -> list[str]:
    if not directory.is_dir():
        print(f"warning: {directory} not found — skipping", file=sys.stderr)
        return []
    return sorted(p.name for p in directory.iterdir() if p.suffix.lower() == ext)


def main() -> int:
    manifest = {kind: collect(directory, ext) for kind, (directory, ext) in SOURCES.items()}

    OUT.write_text(json.dumps(manifest, indent=2) + "\n")

    counts = ", ".join(f"{len(v)} {k}" for k, v in manifest.items())
    print(f"Wrote {OUT.relative_to(ROOT)} ({counts})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
