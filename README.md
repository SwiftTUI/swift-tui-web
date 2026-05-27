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

The `0.0.1` public pre-release is available as npm-compatible tarballs attached
to the GitHub release:

```bash
npm install \
  https://github.com/SwiftTUI/swift-tui-web/releases/download/0.0.1/swifttui-web-0.0.1.tgz \
  https://github.com/SwiftTUI/swift-tui-web/releases/download/0.0.1/swifttui-build-0.0.1.tgz
```

After npm publication, consumers can install the package names directly:

```bash
npm install @swifttui/web @swifttui/build
```

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

The GitHub release tarballs are the public dependency path for `0.0.1`. npm
publication is the remaining packaging follow-up once npm credentials are
available.
