# AGENTS.md

Guidance for agentic assistants working in **`swift-tui-web`**. Keep this
concise. This is the Bun/npm workspace that ships SwiftTUI's browser-side
packages.

## What this repo is

A Bun workspace with two published packages:

| Package | Path | Role |
| --- | --- | --- |
| [`@swifttui/web`](packages/web) | `packages/web` | Browser **runtime**: scene-manifest loading, canvas rendering, ARIA mount, WebSocket + WASI scene bridges |
| [`@swifttui/build`](packages/build) | `packages/build` | Build/packaging **tooling**: manifest capture + wasm packaging (`swifttui-web` CLI) |

Keep the runtime/tooling split: browser-safe APIs in `web`, build steps in
`build`. Each package has its own `AGENTS.md` with specifics.

## Toolchains

- **Bun** for dev, bundling, and tests.
- **`swiftly`** Swift 6.3.1 for any Swift the build path triggers
  (`swiftly run swift --version`). Not bare `swift`/`xcrun swift`.

Run `bun install` from this root; one root `bun.lock` covers both packages.

## Commands

```bash
bun run ci          # repo gate: install --frozen-lockfile + test + build:web
bun test            # all package tests
bun run build:web   # build the web package's browser bundle
```

`//:swift_tui_web_native_gate` in the org root runs `bun run ci`.

## Conventions

`AGENTS.md` is the real file; `CLAUDE.md` is a symlink to it. Edit `AGENTS.md`.
This repo is consumed both standalone (npm) and as a submodule of
`SwiftTUI/swift-tui-org`; keep it Bun/npm-consumable.
