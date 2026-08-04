# SwiftTUI Web Packages

**SwiftUI semantics, drawn in terminal cells — now on a web page.**

The browser-host packages for [SwiftTUI](https://swifttui.sh). Author your `App`
once and ship the same `View` tree, the same `@State`, the same `@FocusState` to
a `<canvas>` — no rewrite, no terminal emulator, no `xterm.js`.

[![npm @swifttui/web](https://img.shields.io/npm/v/@swifttui/web?label=%40swifttui%2Fweb)](https://www.npmjs.com/package/@swifttui/web)
[![npm @swifttui/build](https://img.shields.io/npm/v/@swifttui/build?label=%40swifttui%2Fbuild)](https://www.npmjs.com/package/@swifttui/build)
![License](https://img.shields.io/badge/license-MIT-3DA639)

A SwiftTUI app compiles to `wasm32-wasi` and streams a structured raster surface.
`@swifttui/web` draws that surface in a canvas. It also mounts an ARIA tree.
Thus, the same `App` and `Scene` run in a terminal and on a web page. These two
packages deliver two of SwiftTUI's five hosts — a **static WASI bundle** and a
**localhost WebHost**. The framework itself lives in
[`SwiftTUI/swift-tui`](https://github.com/SwiftTUI/swift-tui). This repository
contains the browser deployment packages.

> Status: `0.6.2` beta. Source-breaking changes can occur before 1.0.

| Package | Role |
| --- | --- |
| [`@swifttui/web`](packages/web) | Browser runtime: scene-manifest loading, canvas rendering, ARIA mounting, WebSocket + WASI scene bridges |
| [`@swifttui/build`](packages/build) | Build tooling: manifest generation, Swift WASI builds, wasm validation, and the `swifttui-web` CLI |

The split keeps build-time Swift processes and filesystem work out of the
browser-safe runtime. Thus, any bundler can import the runtime.

**Run the demo:** a live SwiftTUI app compiled to `wasm32-wasi` and mounted via
`@swifttui/web` runs at <https://swifttui.sh/webexample>. The reference template
that produces it is
[`swift-tui-examples/WebExample`](https://github.com/SwiftTUI/swift-tui-examples/tree/main/WebExample).

## Installation

Both packages publish to npm as ESM with bundled TypeScript declarations. You
do not need Bun or a TypeScript toolchain to use them. They contain compiled
`dist/` JavaScript and declarations (`.js` + `.d.ts`):

```bash
npm install @swifttui/web @swifttui/build
```

Each tagged GitHub release also attaches npm-compatible tarballs:

```bash
npm install \
  https://github.com/SwiftTUI/swift-tui-web/releases/download/0.6.2/swifttui-web-0.6.2.tgz \
  https://github.com/SwiftTUI/swift-tui-web/releases/download/0.6.2/swifttui-build-0.6.2.tgz
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

The WASI runtime starts only if the host page serves these two headers. The
headers enable the `SharedArrayBuffer`-backed stdin that the runtime uses.
Without them, the canvas stays blank:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

## Working on these packages

Use the commands below to develop these packages. An app needs only the
`npm install` command above. It does not need Bun or the Swift toolchain.

```bash
bun install
bun test
bun run build:packages   # compile both packages to dist/ (tsdown: ESM + .d.ts)
bun run build:web        # bundle the in-repo browser demo to dist-demo/
bun run ci               # frozen install + test + build:packages + build:web
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

## Documentation and support

- **Read the DocC** — project site + live API reference: <https://swifttui.sh/docs/documentation/>
- **The framework** — authoring API, products, and the full platform matrix: [`SwiftTUI/swift-tui`](https://github.com/SwiftTUI/swift-tui)
- **The other hosts** — terminal (the default `SwiftTUI` import), native SwiftUI via [`swift-tui-swiftui`](https://github.com/SwiftTUI/swift-tui-swiftui) (macOS · iOS), and Jetpack Compose via [`swift-tui-android`](https://github.com/SwiftTUI/swift-tui-android)
- **Questions and issues:** <https://github.com/SwiftTUI/swift-tui-web/issues>

## License

MIT — see [LICENSE](LICENSE). Each published package (`@swifttui/web`,
`@swifttui/build`) also bundles the license text.
