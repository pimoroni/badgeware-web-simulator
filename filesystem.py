#!/usr/bin/env python3
import glob
import pathlib
import json

def walk_dir(dir, relative=True):
    for filename in glob.iglob(str(pathlib.Path(dir) / "**/*"), recursive=True):
        path = pathlib.Path(filename)
        if path.is_file():
            if relative:
                path = path.relative_to(dir)
            yield path

files = [f"/{f}" for f in walk_dir("simulator/filesystem")]

files = {"files": files}

files = json.dumps(files, indent=4)

print(files)
