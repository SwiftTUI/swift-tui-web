# `@swifttui/web`

**Browser runtime for [SwiftTUI](https://swifttui.sh) apps — draw a
Swift-authored UI into a `<canvas>`, no terminal emulator.**

[![npm](https://img.shields.io/npm/v/@swifttui/web)](https://www.npmjs.com/package/@swifttui/web)
![License](https://img.shields.io/badge/license-MIT-3DA639)

`@swifttui/web` is the browser host for SwiftTUI. A SwiftTUI app compiles to
`wasm32-wasi` and sends a structured raster surface on stdout. This package
loads the scene manifest and renders that surface in a canvas. It mounts an
ARIA tree for accessibility and sends input to the running app. Thus, the same
view code runs in a terminal and on a web page. The package does not load a
terminal emulator.

The build side — compiling your Swift app to wasm and capturing its manifest —
lives in the sibling
[`@swifttui/build`](https://www.npmjs.com/package/@swifttui/build) package.

- **Live demo:** <https://swifttui.sh/webexample>
- **Reference template:** [`swift-tui-examples/WebExample`](https://github.com/SwiftTUI/swift-tui-examples/tree/main/WebExample)
  (≈60 lines of embedding code)
- **The framework:** [`SwiftTUI/swift-tui`](https://github.com/SwiftTUI/swift-tui)

## Installation

Published to npm as an ESM package with bundled TypeScript declarations — no
TypeScript toolchain is necessary to use it:

```bash
npm install @swifttui/web
```

The package contains compiled JavaScript and declarations in `dist/`
(`.js` + `.d.ts`). You do **not** need Bun or a TypeScript build step. Subpath entry points
(`./wasi`, `./wasi-worker`, `./manifest`, `./websocket`, `./testing`) and the
`./style.css` asset are declared in `package.json` `exports`.

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

The page that hosts the WASI runtime must serve
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` so the `SharedArrayBuffer`-backed
stdin works.

## Renderers

One option selects between two surface presenters. Both presenters consume the
same frames:

```ts
await createWebHostApp({
  mount,
  manifestUrl,
  renderer: "dom", // "canvas" is the default
});
```

- **`"canvas"`** (default) paints cells on one 2D `<canvas>` DOM node. It draws
  exact box seams and decoration patterns.
- **`"dom"`** renders cells as absolutely positioned text elements. It uses
  browser font shaping and fallback for emoji and CJK. Text stays sharp at each
  page zoom, and the element tree is inspectable. Hold Alt/Option and drag to
  select and copy app text. A drag without Alt/Option remains pointer input for
  the app. Box characters render as font glyphs. Underline and strikethrough
  patterns use CSS `text-decoration`. Thus, thin details can differ from the
  canvas painter. `letter-spacing` stretches each glyph advance to the cell
  width and keeps the grid aligned.

The option is also available for each scene runtime through
`WebHostSceneRuntimeOptions.renderer`. The package exports both painters:
`CanvasSurfacePainter` and `DomSurfacePainter`. Hosts can use these painters in
custom runtimes.

## Surface transport

This package uses SwiftTUI's `web-surface` WASI transport. The Swift runner
emits structured raster-surface records on stdout, and the browser host draws
them with the configured renderer — canvas rects/text or DOM elements. It does
not load a terminal emulator and does not depend on `ghostty-web` or
`ghostty-vt.wasm`.

`web-surface` is the default `SwiftTUIWASI` browser transport. WebHost still
sets `SWIFTTUI_TRANSPORT=surface` explicitly so generated app environments are
self-describing.

## Notes

- Scene switching is controller-managed and retains existing scene runtimes.
- Terminal styling is host-owned through `WebHostTerminalStyle`, which carries
  one active palette/theme pair plus the runtime payload sent into SwiftTUI.
- Hosts with multiple themes swap entire `WebHostTerminalStyle` objects. The
  library does not provide a built-in mode switcher.
- `BrowserWASIBridge` sets `SWIFTTUI_TRANSPORT=surface` and decodes surface
  frames before handing them to the canvas runtime.
- Hyperlink cells from the app use `links` and `linkTargets` on the frame. A
  click opens an `http(s)` target in a new tab. The `onOpenHyperlink` runtime
  option can open the target instead. A pointer cursor identifies linked
  cells. Accessibility nodes that the app marks `hidden` do not enter the ARIA
  tree. The runtime exposes the frame `focusPresentation` and
  `preferredGridSize` values to hosts.

## Developing this package

> This section applies only to work **on** `@swifttui/web`. An app that uses the
> package needs only the `npm install` command above. It does not need Bun or
> the Swift toolchain.

Use Bun for local development. Use the repository `swiftly` Swift 6.3.3
toolchain for each Swift command that the build pipeline starts
(`swiftly run swift --version`). Run `bun install` from the repository root or
a workspace package directory. Bun maintains one root `bun.lock`.

- `bun test`
- `bun run build` — Compile the publishable package to `dist/` with tsdown.
  The output contains ESM `.js` and `.d.ts` files. `prepublishOnly` runs this
  command during publication.
- `bun run build:manifest -- --app <AppExecutable>`
- `bun run build:wasm -- --app <AppExecutable>`
- `bun run build:web`
- `bun run build:app -- --app <AppExecutable>`
- `bun run dev`

`build` produces the published library. `build:manifest`, `build:wasm`, and
`build:app` delegate manifest and WASI packaging to `@swifttui/build`.
`build:wasm` and `build:app` use `--configuration release` by default. Pass
`--configuration debug` for local debug wasm builds. The demo app pipeline
writes its artifacts to `dist-demo/`. Thus, they stay separate from the
published `dist/` library output.

The demo/app build flow is intentionally small:

1. `build:manifest` runs `swiftly run swift` and captures the Swift app output for `SWIFTTUI_MODE=manifest`.
2. `build:wasm` copies the app wasm artifact to
   `dist-demo/assets/app.wasm`. The command makes sure that the browser
   `WebAssembly` API accepts the artifact. Then it strips the artifact. It keeps
   the stripped artifact only if the browser can parse it.
3. `build:web` bundles `index.html` and the browser entrypoint with Bun.

## License

MIT — see [LICENSE](LICENSE).
