# `@swifttui/build`

**Build tooling for [SwiftTUI](https://swifttui.sh) browser deployments —
compile a SwiftTUI app to `wasm32-wasi` and capture its scene manifest.**

[![npm](https://img.shields.io/npm/v/@swifttui/build)](https://www.npmjs.com/package/@swifttui/build)
![License](https://img.shields.io/badge/license-MIT-3DA639)

`@swifttui/build` turns a SwiftTUI app into the two artifacts the browser needs:
an `app.wasm` and a `scene-manifest.json`. It drives the Swift toolchain, runs a
browser `WebAssembly.compile` validation pass, and packages the result. It
intentionally sits outside [`@swifttui/web`](https://www.npmjs.com/package/@swifttui/web)
(the browser runtime) so runtime imports never pull in Swift process spawning,
Node filesystem APIs, or wasm packaging helpers.

- **Runtime counterpart:** [`@swifttui/web`](https://www.npmjs.com/package/@swifttui/web)
  — mounts the artifacts this package produces.
- **Reference template:** [`swift-tui-examples/WebExample`](https://github.com/SwiftTUI/swift-tui-examples/tree/main/WebExample)
- **The framework:** [`SwiftTUI/swift-tui`](https://github.com/SwiftTUI/swift-tui)

## Installation

Published to npm as an ESM package with a Node CLI and bundled TypeScript
declarations:

```bash
npm install --save-dev @swifttui/build
```

This exposes the `swifttui-web` CLI (`npx swifttui-web build --app <Exe>`) and a
programmatic ESM API. The package ships compiled `dist/` JavaScript — the bin
runs on plain Node (`#!/usr/bin/env node`), no Bun or TypeScript toolchain
required to consume it. Building a SwiftTUI app to wasm does require a Swift
6.3.x toolchain and the `swift-6.3.1-RELEASE_wasm` SDK on your machine.

## Use

From the command line:

```bash
npx swifttui-web build --app <AppExecutable>
```

Or programmatically:

```ts
import { buildSwiftTUIWebApp } from "@swifttui/build";

await buildSwiftTUIWebApp({
  packagePath: ".",
  product: "MyApp",
  outputDirectory: "dist",
});
```

Toolchain defaults match the repo:

- Swift command: `swiftly run swift` when `swiftly` is on `PATH`, otherwise
  `swift`
- SDK: `swift-6.3.1-RELEASE_wasm`
- Release Swift flags:
  `-Xswiftc -Osize -Xswiftc -Xfrontend -Xswiftc -disable-llvm-merge-functions-pass`
- Initial memory: `536870912`
- Max memory: `4294967296`
- Stack size: `1048576`

Callers can override `swiftCommand`, `swiftSDK`, `configuration`,
`initialMemory`, `maxMemory`, `stackSize`, `extraSwiftcFlags`,
`extraLinkerFlags`, and `extraSwiftBuildArgs`.

> The WASI release flags (`-Osize` plus `-disable-llvm-merge-functions-pass`)
> keep the output under the browser `WebAssembly` API's 1000-parameter limit.
> The canonical command lives in this package — prefer the CLI/API over a
> hand-rolled `swift build`.

## Developing this package

> Only needed if you are working **on** `@swifttui/build` itself. Consuming it
> from a project needs only `npm install --save-dev` (above).

Use Bun for the CLI, bundling, and tests, and `swiftly` Swift 6.3.1 for the wasm
build it invokes (not bare `swift`).

- `bun test`
- `bun run build` — compile the publishable package to `dist/` with tsdown
  (ESM `.js` + `.d.ts`, plus the `swifttui-web` bin). Run automatically on
  publish via `prepublishOnly`.
- `bun run build:manifest -- --app <AppExecutable>`
- `bun run build:wasm -- --app <AppExecutable>`

The full app pipeline (manifest + wasm) is exposed through the CLI:

```bash
bun run cli.ts build --app <AppExecutable>    # from source
npx swifttui-web build --app <AppExecutable>  # from the published bin
```

## License

MIT — see [LICENSE](LICENSE).
