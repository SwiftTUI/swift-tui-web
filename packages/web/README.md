# `@swifttui/web`

Browser runtime package for SwiftTUI apps.

This package owns browser-safe runtime APIs: scene manifest loading, canvas
rendering, ARIA mounting, WebSocket scene bridges, and WASI scene bridges. Build
tooling lives in the sibling [`@swifttui/build`](../build) workspace package.

## Installation

Published to npm as an ESM package with bundled TypeScript declarations — no
TypeScript toolchain required to consume it:

```bash
npm install @swifttui/web
```

The package ships compiled `dist/` JavaScript (`.js` + `.d.ts`); consuming it
does **not** require Bun or a TypeScript build step. Subpath entrypoints
(`./wasi`, `./wasi-worker`, `./manifest`, `./websocket`, `./testing`) and the
`./style.css` asset are declared in `package.json` `exports`.

## Toolchains

Use Bun for repo-local development of this package, and use the repo-default
`swiftly` Swift 6.3.1 toolchain for every Swift command that the build pipeline
triggers.

Quick check:

```bash
swiftly run swift --version
```

Native-only development should also work in Xcode, but the documented package
and wasm build path uses `swiftly` plus Bun.

For source development, run `bun install` from the repo root or from any
workspace package directory, and Bun will maintain one root `bun.lock` plus
stable relative workspace links.

## Surface Transport

This package uses SwiftTUI's `web-surface` WASI transport. The Swift runner
emits structured raster-surface records on stdout, and the browser host draws
rectangles and text into a canvas. It does not load a terminal emulator and does
not depend on `ghostty-web` or `ghostty-vt.wasm`.

`web-surface` is the default `SwiftTUIWASI` browser transport. WebHost still
sets `TUIGUI_TRANSPORT=surface` explicitly so generated app environments are
self-describing.

## API

```ts
import { createWebHostApp } from "@swifttui/web";

const controller = await createWebHostApp({
  mount: document.getElementById("app")!,
  manifestUrl: new URL("./scene-manifest.json", import.meta.url),
  style: {
    palette: {
      foreground: "#eceff4",
      background: "#1e222a",
      cursor: "#56b6c2",
      selectionBackground: "#2e3440",
      selectionForeground: "#eceff4",
    },
    theme: {
      foreground: "#eceff4",
      background: "#1e222a",
      tint: "#56b6c2",
      link: "#5ba3ff",
    },
  },
});

await controller.switchScene("dashboard");
controller.setStyle({ cursorBlink: true, theme: { tint: "#79c0ff" } });
```

For a static WASI-hosted app, use the WASI subpath:

```ts
import { createWasmSceneRuntimeFactory } from "@swifttui/web/wasi";
```

Worker entrypoints can delegate to:

```ts
import { startWasmSceneWorker } from "@swifttui/web/wasi-worker";

startWasmSceneWorker();
```

## Scripts

- `bun test`
- `bun run build` — compile the publishable package to `dist/` with tsdown
  (ESM `.js` + `.d.ts`). Run automatically on publish via `prepublishOnly`.
- `bun run build:manifest -- --app <AppExecutable>`
- `bun run build:wasm -- --app <AppExecutable>`
- `bun run build:web`
- `bun run build:app -- --app <AppExecutable>`
- `bun run dev`

`build` produces the published library. `build:manifest`, `build:wasm`, and
`build:app` delegate manifest/WASI packaging to `@swifttui/build`; `build:wasm`
and `build:app` default to `--configuration release` (pass
`--configuration debug` for local debug-oriented wasm builds). The demo/app
pipeline writes its artifacts to `dist-demo/` so they stay separate from the
published `dist/` library output.

The demo/app build flow is intentionally small:

1. `build:manifest` captures `TUIGUI_MODE=manifest` output from the Swift app by invoking `swiftly run swift`.
2. `build:wasm` copies the app's wasm artifact into `dist-demo/assets/app.wasm`,
   validates it with the browser `WebAssembly` API, then keeps the stripped
   artifact only if stripping still produces browser-parseable wasm.
3. `build:web` bundles `index.html` and the browser entrypoint with Bun.

## Notes

- Scene switching is controller-managed and retains existing scene runtimes.
- Terminal styling is host-owned through `WebHostTerminalStyle`, which carries
  one active palette/theme pair plus the runtime payload sent into SwiftTUI.
- Hosts that want multiple themes swap entire `WebHostTerminalStyle` objects;
  the library does not provide a built-in mode switcher.
- `BrowserWASIBridge` sets `TUIGUI_TRANSPORT=surface` and decodes surface
  frames before handing them to the canvas runtime.
