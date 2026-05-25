# AGENTS.md

Guidance for agentic assistants working in **`@swifttui/web`**. Keep this
concise; [`README.md`](README.md) is the full reference.

## What this package is

The **browser runtime** for SwiftTUI apps. It owns the browser-safe runtime
APIs: scene-manifest loading, canvas rendering, ARIA mounting, WebSocket scene
bridges, and WASI scene bridges. Build/packaging tooling lives in the sibling
[`@swifttui/build`](../build) workspace package — keep that split.

It lives in the repo's Bun workspace (`packages/web` in `swift-tui-web`). Run
`bun install` from the repo root or any package dir; one root `bun.lock` is
maintained.

## Toolchains

- **Bun** for dev, bundling, and the test runner.
- **`swiftly`** Swift 6.3.1 for any Swift the build path triggers
  (`swiftly run swift --version`). Do not use bare `swift`/`xcrun swift`.

## Commands

```bash
bun test                      # this package's tests (or `bun run test`)
bun run build:web             # bundle index.html + browser entrypoint
bun run build -- --app <Exe>  # full build (manifest + wasm + web)
bun run dev                   # watch/dev
```

`build:manifest` and `build:wasm` delegate to `@swifttui/build` and default to
`--configuration release`. The org-level gate for this repo is `bun run ci`
(install --frozen-lockfile + test + build:web), run from the `swift-tui-web` root.

## Architecture notes

- Transport is SwiftTUI's **`web-surface` WASI transport**: the Swift runner
  emits raster-surface records on stdout and the host draws rects/text to a
  canvas. **No terminal emulator** — does not use `ghostty-web`/`ghostty-vt.wasm`.
  `BrowserWASIBridge` sets `TUIGUI_TRANSPORT=surface`.
- Entry points: `createWebHostApp` (`.`), `createWasmSceneRuntimeFactory`
  (`./wasi`), `startWasmSceneWorker` (`./wasi-worker`). Subpath exports are
  declared in `package.json` — keep `exports` in sync when adding modules.
- Scene switching is controller-managed and retains existing scene runtimes.
- Terminal styling is host-owned via `WebHostTerminalStyle` (one active
  palette/theme pair); the library ships no built-in mode switcher.

## Conventions

`AGENTS.md` is the real file; `CLAUDE.md` is a symlink to it. Edit `AGENTS.md`.
Tests are colocated as `*.test.ts` (browser-only specs use `*.browser.ts`).
