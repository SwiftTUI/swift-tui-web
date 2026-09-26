"""Rebuild the bundled font from pinned upstream source; never install system-wide."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import unicodedata
import urllib.request
import zipfile

from fontTools.ttLib import TTFont

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / ".build/font-source"
# OpenType timestamps use the 1904 epoch. Normalize packaging even when the
# upstream incremental build reuses a product made before SOURCE_DATE_EPOCH.
EPOCH = 1790380800  # 2026-09-26 00:00:00 UTC


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--package-only", action="store_true",
                        help="Package existing source-build products; do not rebuild")
    parser.add_argument("--clean", action="store_true",
                        help="Discard only the upstream generated .build and dist directories")
    args = parser.parse_args()
    previous = json.loads((OUT / "build.json").read_text()) if (OUT / "build.json").exists() else None
    profile = json.loads((HERE / "profile.json").read_text())
    # Pin Unicode classification, as well as the source font, for the corpus.
    if unicodedata.unidata_version != "15.1.0":
        raise RuntimeError("Use Python 3.13 / Unicode data 15.1.0")
    singles = {chr(cp) for lo, hi in profile["ranges"] for cp in range(lo, hi + 1)
               if unicodedata.category(chr(cp)) not in profile["excludeCategories"]}
    singles.update(profile["symbols"])
    singles.difference_update(chr(cp) for cp in profile.get("excludeCodepoints", []))
    texts = set(singles)
    if profile["canonicalDecompositions"]:
        texts.update(unicodedata.normalize("NFD", text) for text in singles)
    corpus = {"unicodeVersion": unicodedata.unidata_version,
              "singleCharacters": len(singles), "texts": sorted(texts)}
    build_singles = {chr(cp) for lo, hi in profile.get("buildRanges", profile["ranges"]) for cp in range(lo, hi + 1)
                     if unicodedata.category(chr(cp)) not in profile["excludeCategories"]}
    build_singles.update(profile.get("buildSymbols", profile["symbols"]))
    build_singles.difference_update(chr(cp) for cp in profile.get("excludeCodepoints", []))
    build_texts = build_singles | {unicodedata.normalize("NFD", t) for t in build_singles}
    scalars = "".join(sorted(set("".join(build_texts))))
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "core-corpus.json").write_text(json.dumps(corpus, ensure_ascii=False, indent=2) + "\n")
    archive = OUT / profile["source"]["archive"]
    if not archive.exists():
        urllib.request.urlretrieve(profile["source"]["url"], archive)
    if sha(archive.read_bytes()) != profile["source"]["sha256"]:
        raise RuntimeError("Source archive checksum mismatch")
    source = OUT / "Iosevka-34.8.1"
    if not source.exists():
        with zipfile.ZipFile(archive) as z:
            for member in z.infolist():
                if not (OUT / member.filename).resolve().is_relative_to(OUT.resolve()):
                    raise RuntimeError("Unsafe archive path")
            z.extractall(OUT)
    if args.clean:
        if args.package_only:
            raise RuntimeError("--clean requires a source build")
        for name in [".build", "dist"]:
            shutil.rmtree(source / name, ignore_errors=True)
    shutil.copyfile(HERE / "private-build-plans.toml", source / "private-build-plans.toml")
    (source / "swifttui-core-characters.txt").write_text(scalars)
    if not args.package_only:
        with (OUT / "npm-ci.log").open("w") as log:
            subprocess.run(["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
                           cwd=source, stdout=log, stderr=subprocess.STDOUT, check=True)
        with (OUT / "font-build.log").open("w") as log:
            subprocess.run(["npm", "run", "build", "--", f"ttf-unhinted::{profile['id']}", "--jCmd=2"],
                           cwd=source, env={**os.environ, "SOURCE_DATE_EPOCH": str(EPOCH)},
                           stdout=log, stderr=subprocess.STDOUT, check=True)
    fonts = OUT / "fonts"
    fonts.mkdir(exist_ok=True)
    faces = []
    for style in profile["styles"]:
        original = source / f"dist/{profile['id']}/TTF-Unhinted/{profile['id']}-{style}.ttf"
        font = TTFont(original, recalcTimestamp=False)
        font["head"].created = font["head"].modified = EPOCH + 2082844800
        # Upstream embeds the build year independently of SOURCE_DATE_EPOCH.
        # Pin that informational year to this candidate's source license year.
        for record in font["name"].names:
            if record.nameID == 0:
                notice = re.sub(r"Copyright 2015-\d{4}", "Copyright 2015-2026", record.toUnicode())
                record.string = notice.encode(record.getEncoding())
        font.flavor = "woff2"
        path = fonts / f"{profile['id']}-{style}.woff2"
        font.save(path)
        faces.append({"style": style, "file": path.name,
                      "bytes": path.stat().st_size, "sha256": sha(path.read_bytes())})
    shutil.copyfile(source / "LICENSE.md", fonts / "OFL-Iosevka.md")
    result = {"profile": profile["id"], "source": profile["source"], "epoch": EPOCH,
              "planSHA256": sha((HERE / "private-build-plans.toml").read_bytes()),
              "profileSHA256": sha((HERE / "profile.json").read_bytes()),
              "corpusSHA256": sha((OUT / "core-corpus.json").read_bytes()),
              "sourceLockSHA256": sha((source / "package-lock.json").read_bytes()),
              "fontToolsVersion": __import__("fontTools").__version__,
              "node": subprocess.check_output(["node", "--version"], text=True).strip(),
              "unhinted": True, "faces": faces}
    (OUT / "build.json").write_text(json.dumps(result, indent=2) + "\n")
    if args.clean and previous:
        verification = {"pass": previous["faces"] == faces, "firstFaces": previous["faces"],
                        "rebuiltFaces": faces,
                        "method": "Removed upstream .build and dist; repeated npm ci and source build with pinned packaging metadata."}
        (OUT / "reproducibility.json").write_text(json.dumps(verification, indent=2) + "\n")
        if not verification["pass"]:
            raise RuntimeError("Clean rebuild produced different font bytes; inspect reproducibility.json")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
