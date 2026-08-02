# AGENTS.md

Guidance for agentic assistants working in **`@swifttui/web`**. Keep this
file concise. [`README.md`](README.md) is the full reference.

## What this package is

This package contains the **browser runtime** for SwiftTUI apps. It owns the
browser-safe runtime APIs. These APIs load scene manifests, render canvas and
DOM surfaces, mount ARIA content, and bridge WebSocket and WASI scenes. Keep
build and packaging tools in the sibling [`@swifttui/build`](../build) package.

It is in the repository Bun workspace (`packages/web` in `swift-tui-web`). Run
`bun install` from the repository root or a package directory. Bun maintains
one root `bun.lock`.

## Toolchains

- Use **Bun** for development, bundling, and the test runner.
- Use **`swiftly`** Swift 6.3.3 for each Swift command that the build starts
  (`swiftly run swift --version`). Do not use bare `swift`/`xcrun swift`.

## Commands

```bash
bun test                          # this package's tests (or `bun run test`)
bun run build                     # compile the publishable package to dist/ (tsdown: ESM .js + .d.ts)
bun run build:web                 # bundle the browser demo (index.html) to dist-demo/
bun run build:app -- --app <Exe>  # full app pipeline (manifest + wasm + web) to dist-demo/
bun run dev                       # watch/dev
```

`build` produces the published library in `dist/`. `prepublishOnly` runs this
command again during publication. `build:manifest`, `build:wasm`, and
`build:app` delegate to `@swifttui/build`. They use `--configuration release`
by default. Their output goes to `dist-demo/`, separate from the published
`dist/`. Run the organization gate, `bun run ci`, from the `swift-tui-web`
root. This gate installs frozen dependencies, tests, and runs both builds.

## Architecture notes

- The transport is the SwiftTUI **`web-surface` WASI transport**. The Swift
  runner emits raster-surface records on stdout. The host draws rectangles and
  text to a canvas. It does not use a terminal emulator such as `ghostty-web`
  or `ghostty-vt.wasm`.
  `BrowserWASIBridge` sets `SWIFTTUI_TRANSPORT=surface`.
- Entry points: `createWebHostApp` (`.`), `createWasmSceneRuntimeFactory`
  (`./wasi`), `startWasmSceneWorker` (`./wasi-worker`). Subpath exports are
  declared in `package.json`. If you add modules, keep `exports` synchronized.
- Scene switching is controller-managed and retains existing scene runtimes.
- The host owns terminal styling through `WebHostTerminalStyle` with one active
  palette and theme pair. The library has no built-in mode switcher.

## Conventions

`AGENTS.md` is the real file. `CLAUDE.md` is a symlink to it. Edit `AGENTS.md`.
Tests are colocated as `*.test.ts` (browser-only specs use `*.browser.ts`).
