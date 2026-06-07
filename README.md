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

Both packages are published to npm as ESM with bundled TypeScript declarations.
No Bun or TypeScript toolchain is required to consume them — they ship compiled
`dist/` JavaScript (`.js` + `.d.ts`):

```bash
npm install @swifttui/web @swifttui/build
```

The GitHub release also attaches npm-compatible tarballs as an alternative
install path:

```bash
npm install \
  https://github.com/SwiftTUI/swift-tui-web/releases/download/0.0.18/swifttui-web-0.0.18.tgz \
  https://github.com/SwiftTUI/swift-tui-web/releases/download/0.0.18/swifttui-build-0.0.18.tgz
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
bun run build:packages   # compile both packages to dist/ (tsdown: ESM + .d.ts)
bun run build:web        # bundle the in-repo browser demo to dist-demo/
bun run ci               # frozen install + test + build:packages + build:web
```

The publishable artifacts are the compiled `dist/` directories produced by
`build:packages` (each package's `prepublishOnly` also runs the build, so
`npm publish` always ships fresh output). `package.json` `exports` point at
`dist/*`; raw TypeScript source is never shipped.

Package tarballs for release can be generated locally with:

```bash
bun run pack:web
bun run pack:build
```

`bun pm pack` (and `bun publish`) rewrite the internal `workspace:*` dependency
to the concrete version, so the published `@swifttui/build` depends on a real
`@swifttui/web` version.
