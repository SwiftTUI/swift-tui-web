# AGENTS.md

Guidance for agentic assistants working in **`swift-tui-web`**. Keep this
concise. This is the Bun/npm workspace that ships SwiftTUI's browser-side
packages.

## What this repo is

A Bun workspace with two packages intended for public release:

| Package | Path | Role |
| --- | --- | --- |
| [`@swifttui/web`](packages/web) | `packages/web` | Browser **runtime**: scene-manifest loading, canvas + DOM rendering, ARIA mount, WebSocket + WASI scene bridges |
| [`@swifttui/build`](packages/build) | `packages/build` | Build/packaging **tooling**: manifest capture + wasm packaging (`swifttui-web` CLI) |

Keep browser-safe APIs in `web`. Keep build steps in `build`. Each package has
an `AGENTS.md` file with package-specific instructions.

## Toolchains

- Use **Bun** for development, bundling, and tests.
- Use **`swiftly`** Swift 6.3.3 for each Swift command that the build starts
  (`swiftly run swift --version`). Do not use bare `swift` or `xcrun swift`.

Run `bun install` from this root. One root `bun.lock` covers both packages.

## Commands

```bash
bun run ci             # repo gate: install --frozen-lockfile + test + build:packages + build:web
bun test               # all package tests
bun run build:packages # compile both packages to dist/ (tsdown: ESM .js + .d.ts)
bun run build:web      # build the web package's browser demo bundle (dist-demo/)
```

`//:swift_tui_web_native_gate` in the org root runs `bun run ci`.

## Conventions

`AGENTS.md` is the real file. `CLAUDE.md` is a symlink to it. Edit `AGENTS.md`.
This repo must remain Bun/npm-consumable. Public release work must publish
`@swifttui/web` and `@swifttui/build` to npm or attach package tarballs to a
tagged GitHub release.
