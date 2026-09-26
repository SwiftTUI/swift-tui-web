# Bundled DOM font

SwiftTUI Core Candidate 3 (0.3.0) is a renamed, unhinted source build of Iosevka
34.8.1. Four WOFF2 faces total 167,584 bytes. `manifest.json` records upstream,
source archive and per-face SHA-256 hashes, packaging tools and normalized epoch.
`LICENSE.md` preserves the upstream SIL Open Font License 1.1 and copyright.

`private-build-plans.toml` is Iosevka's build configuration, not a product plan.
It retains a 600-unit advance and 1.5em leading with increased sidebearings,
smaller accents and a four-degree italic. `profile.json` defines the printable
Basic Latin/Latin-1 core and broader best-effort coverage; `core-corpus.json`
contains the 243 original/canonically decomposed qualification strings.

To reproduce the bytes, use Python 3.13 (Unicode 15.1), fontTools 4.66.0 with
Brotli, Node 26.10.0 and npm. Run `python3 rebuild.py --clean` from this directory.
The script verifies the upstream source archive, uses its npm lockfile, builds
all four real faces, and normalizes font metadata before WOFF2 packaging.
Outputs go to `../.build/font-source/`; the script does not install fonts or
replace committed assets. A subsequent clean rebuild compares all face hashes.
The runtime consumes the committed WOFF2 assets and does not require these
font-development tools.
