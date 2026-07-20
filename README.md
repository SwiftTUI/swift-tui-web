# SwiftTUI Web Packages

**SwiftUI semantics, drawn in terminal cells — now on a web page.**

The browser-host packages for [SwiftTUI](https://swifttui.sh). Author your `App`
once and ship the same `View` tree, the same `@State`, the same `@FocusState` to
a `<canvas>` — no rewrite, no terminal emulator, no `xterm.js`.

[![npm @swifttui/web](https://img.shields.io/npm/v/@swifttui/web?label=%40swifttui%2Fweb)](https://www.npmjs.com/package/@swifttui/web)
[![npm @swifttui/build](https://img.shields.io/npm/v/@swifttui/build?label=%40swifttui%2Fbuild)](https://www.npmjs.com/package/@swifttui/build)
![License](https://img.shields.io/badge/license-MIT-3DA639)

A SwiftTUI app compiles to `wasm32-wasi` and streams a structured raster surface.
`@swifttui/web` draws that surface into a canvas and mounts an ARIA tree, so the
same `App` and `Scene` you run in a terminal run on a web page. These two
packages deliver two of SwiftTUI's five hosts — a **static WASI bundle** and a
**localhost WebHost**. The framework itself lives in
[`SwiftTUI/swift-tui`](https://github.com/SwiftTUI/swift-tui); this repo is the
deployment story for the browser.

> Status: `0.1.10` beta — source-breaking changes may land before 1.0.

| Package | Role |
| --- | --- |
| [`@swifttui/web`](packages/web) | Browser runtime: scene-manifest loading, canvas rendering, ARIA mounting, WebSocket + WASI scene bridges |
| [`@swifttui/build`](packages/build) | Build tooling: manifest generation, Swift WASI builds, wasm validation, and the `swifttui-web` CLI |

The split keeps browser-safe runtime imports out of build-time Swift process
spawning and filesystem work — so the runtime stays importable in any bundler.

**Run the demo:** a live SwiftTUI app compiled to `wasm32-wasi` and mounted via
`@swifttui/web` runs at <https://swifttui.sh/webexample>. The reference template
that produces it is
[`swift-tui-examples/WebExample`](https://github.com/SwiftTUI/swift-tui-examples/tree/main/WebExample).

## Installation

Both packages publish to npm as ESM with bundled TypeScript declarations. You
need no Bun or TypeScript toolchain to consume them — they ship compiled `dist/`
JavaScript (`.js` + `.d.ts`):

```bash
npm install @swifttui/web @swifttui/build
```

Each tagged GitHub release also attaches npm-compatible tarballs:

```bash
npm install \
  https://github.com/SwiftTUI/swift-tui-web/releases/download/0.1.10/swifttui-web-0.1.10.tgz \
  https://github.com/SwiftTUI/swift-tui-web/releases/download/0.1.10/swifttui-build-0.1.10.tgz
```

## Basic use

Build a SwiftTUI app to WASI with the build package:

```bash
npx swifttui-web build --package-path ./TerminalApp --app MyApp
```

Mount the resulting manifest and wasm from the browser runtime:

```ts
import { createWebHostApp } from "@swifttui/web";
import { createWasmSceneRuntimeFactory } from "@swifttui/web/wasi";

await createWebHostApp({
  mount: document.getElementById("app")!,
  manifestUrl: new URL("./scene-manifest.json", import.meta.url),
  sceneRuntimeFactory: createWasmSceneRuntimeFactory(
    new URL("./assets/app.wasm", import.meta.url),
  ),
});
```

The WASI runtime starts only when the hosting page serves these two headers —
they unlock the `SharedArrayBuffer`-backed stdin the runtime needs. Without them
the canvas stays blank:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

## Working on these packages

The commands below are for developing **on** these packages. Consuming them from
an app needs only `npm install` (above) — not Bun or the Swift toolchain.

```bash
bun install
bun test
bun run build:packages   # compile both packages to dist/ (tsdown: ESM + .d.ts)
bun run build:web        # bundle the in-repo browser demo to dist-demo/
bun run ci               # frozen install + test + build:packages + build:web
```

The publishable artifacts are the compiled `dist/` directories from
`build:packages`. Each package's `prepublishOnly` reruns the build, so
`npm publish` always ships fresh output; `package.json` `exports` point at
`dist/*`, and raw TypeScript source is never shipped. Generate release tarballs
with `bun run pack:web` / `bun run pack:build` — `bun pm pack` rewrites the
internal `workspace:*` dependency to the concrete version, so the published
`@swifttui/build` depends on a real `@swifttui/web` release.

## Documentation and support

- **Read the DocC** — project site + live API reference: <https://swifttui.sh/docs/documentation/>
- **The framework** — authoring API, products, and the full platform matrix: [`SwiftTUI/swift-tui`](https://github.com/SwiftTUI/swift-tui)
- **The other hosts** — terminal (the default `SwiftTUI` import), native SwiftUI via [`swift-tui-swiftui`](https://github.com/SwiftTUI/swift-tui-swiftui) (macOS · iOS), and Jetpack Compose via [`swift-tui-android`](https://github.com/SwiftTUI/swift-tui-android)
- **Questions and issues:** <https://github.com/SwiftTUI/swift-tui-web/issues>

## License

MIT — see [LICENSE](LICENSE). Each published package (`@swifttui/web`,
`@swifttui/build`) also bundles the license text.
