# Development

Internal notes for developing the `@swifttui/web` and `@swifttui/build`
workspace. Consumers never need this file: apps install the published npm
packages and need neither Bun nor the Swift toolchain.

Use the commands below to develop these packages.

```bash
bun install
bun test
bun run build:packages   # compile both packages to dist/ (tsdown: ESM + .d.ts)
bun run build:web        # bundle the in-repo browser demo to dist-demo/
bun run ci               # frozen install + test + build:packages + build:web
bun run test:browser     # compiled Swift fixture + Chromium/Firefox/WebKit journeys
```

`build:packages` creates the publishable artifacts in the compiled `dist/`
directories. Each package uses `prepublishOnly` to run the build again before
`npm publish`. The `package.json` `exports` fields point to `dist/*`. Published
packages do not contain raw TypeScript source. Run `bun run pack:web` or
`bun run pack:build` to generate release tarballs. `bun pm pack` replaces the
internal `workspace:*` dependency with a concrete version. Thus, the published
`@swifttui/build` package depends on a published `@swifttui/web` version.

The host-wire corpus in `Fixtures/Transport/conformance-*` is a byte-identical
copy of the canonical `swift-tui` corpus. `bun test` makes sure that its
manifest and body hashes match. It rejects missing or extra bodies. It also
sends each active Canvas and DOM scenario through the real decoder and painter
paths. If a fixture names a different host, keep the copy complete. The
organization fixture gate makes sure that the repositories contain equal bytes.
Image opacity is wire placement state: both painters apply it on every replay,
while decoded payloads remain cached by image id so alpha-only updates do not
repeat or re-decode `dataBase64` bytes.

## Formatting and pre-commit hooks

Sources are formatted and linted by [Biome](https://biomejs.dev) at the version
pinned in `prek.toml`, with the repo's `biome.json`. The hooks run through
[`prek`](https://prek.j178.dev) and are installed per checkout, so run this once
after cloning (and once per additional checkout or worktree):

```bash
prek install
```

The `pre-commit` hook runs `biome check --write` on the staged JavaScript and
TypeScript files — it reformats them and applies Biome's safe fixes in place,
and fails the commit on remaining lint *errors* (warnings pass). Stage the
rewritten files and commit again if it changed anything. The `commit-msg` hook
rejects AI attribution trailers. To check or format the whole tree by hand:

```bash
git ls-files '*.ts' '*.js' | xargs bunx @biomejs/biome@2.5.8 check           # report
git ls-files '*.ts' '*.js' | xargs bunx @biomejs/biome@2.5.8 check --write   # fix
```

The `bun run ci` gate does not run the hooks; it relies on committed sources
being formatted. `packages/web/src/BoxDrawingRenderer.ts` opts out of
`useSimpleNumberKeys` because its glyph tables are keyed by Unicode code point
and read as hex.

Per-package development commands live in `packages/web/AGENTS.md` and
`packages/build/AGENTS.md`.

The [browser journey guide](../packages/web/e2e/README.md) describes the pinned
browser engines, Swift/WASI fixture toolchain, per-engine reruns, capability
skips and failure artifacts. CI runs the Canvas pixel oracle, synthetic bridge
journey and real compiled Swift WASM journey in every engine. The regular
`bun run ci` package gate remains independent of Swift and browser installation.
