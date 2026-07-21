# AGENTS.md

Guidance for agentic assistants working in **`@swifttui/web`**. Keep this
concise; [`README.md`](README.md) is the full reference.

## What this package is

The **browser runtime** for SwiftTUI apps. It owns the browser-safe runtime
APIs: scene-manifest loading, canvas + DOM surface rendering, ARIA mounting, WebSocket scene
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
bun test                          # this package's tests (or `bun run test`)
bun run build                     # compile the publishable package to dist/ (tsdown: ESM .js + .d.ts)
bun run build:web                 # bundle the browser demo (index.html) to dist-demo/
bun run build:app -- --app <Exe>  # full app pipeline (manifest + wasm + web) to dist-demo/
bun run dev                       # watch/dev
```

`build` produces the published library (`dist/` is what npm ships; `prepublishOnly`
re-runs it on publish). `build:manifest`, `build:wasm`, and `build:app` delegate to
`@swifttui/build` and default to `--configuration release`; their output goes to
`dist-demo/`, kept separate from the published `dist/`. The org-level gate for this
repo is `bun run ci` (install --frozen-lockfile + test + build:packages + build:web),
run from the `swift-tui-web` root.

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
