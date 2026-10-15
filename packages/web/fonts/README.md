# Bundled DOM font

The DOM renderer uses [Ioskeley Mono](https://github.com/ahatem/IoskeleyMono)
in its normal width: regular (400), bold (700), italic (400) and bold italic
(700). These four WOFF2 files total 407,732 bytes and are preserved byte for
byte from the supplied font files; they are not renamed, subset or rebuilt.

`manifest.json` records the family, embedded version string, upstream project,
per-face sizes and SHA-256 hashes. The embedded version is Iosevka 34.4.0 with
ttfautohint 1.8.4; it does not identify an Ioskeley Mono release tag. `LICENSE.md`
preserves the Iosevka and Ioskeley Mono copyright notices and SIL Open Font
License 1.1. The exact source archive/build configuration for these supplied
bytes is not recorded, so this package does not claim a reproducible source
build.

All four faces have a nominal 600-unit advance per 1,000-unit em. The renderer
measures the loaded faces, keeps its 1.5em line height, and disables font
synthesis and ligatures. Browser tests cover advances, baselines, Unicode
allocation, loading failures and fallback ownership.

`@swifttui/build` verifies and copies these assets with their manifest and
license. The asset directory suffix is the first 12 hexadecimal characters of
the SHA-256 of `manifest.json`, so a font update gets a new cache identity.
