# SwiftTUI Web Packages

Browser runtime and build tooling for SwiftTUI web deployments.

This repo publishes two packages:

| Package | Role |
| --- | --- |
| [`@swifttui/web`](packages/web) | Browser runtime: scene manifest loading, canvas rendering, ARIA mounting, WebSocket scene bridges, and WASI scene bridges |
| [`@swifttui/build`](packages/build) | Build tooling: manifest generation, Swift WASI builds, wasm validation, and the `swifttui-web` CLI |

The split keeps browser-safe runtime imports separate from build-time Swift
process spawning and filesystem work.

## Installation

These package names are reserved for the first public web release. After the
packages are published, consumers will install both:

```bash
npm install @swifttui/web @swifttui/build
```

Until then, use this source checkout and the
[`WebExample`](https://github.com/SwiftTUI/swift-tui-examples/tree/main/WebExample)
template to evaluate the browser path.

## Basic Use

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

The page that hosts the WASI runtime must serve:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

## Source Development

```bash
bun install
bun test
bun run build:web
bun run ci
```

Package tarballs for release can be generated locally with:

```bash
bun run pack:web
bun run pack:build
```

Remaining public-release work: publish both packages to npm, or attach those
tarballs to a tagged public GitHub release so downstream repos can depend on
stable HTTPS artifacts.
