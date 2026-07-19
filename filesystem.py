#!/usr/bin/env python3
import pathlib
import json

ROOT = pathlib.Path("simulator/filesystem")


def walk_files(root):
    for path in sorted(root.rglob("*")):
        if path.is_file() and not str(path).startswith("."):
            yield path


# Map each path to its byte size. The size lets the worker create lazy files
# without a synchronous HEAD probe per file (see simulator/micropython.worker.js).
files = {f"/{p.relative_to(ROOT)}": p.stat().st_size for p in walk_files(ROOT)}

print(json.dumps({"files": files}, indent=4))
