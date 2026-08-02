# `@swifttui/build`

**Build tooling for [SwiftTUI](https://swifttui.sh) browser deployments —
compile a SwiftTUI app to `wasm32-wasi` and capture its scene manifest.**

[![npm](https://img.shields.io/npm/v/@swifttui/build)](https://www.npmjs.com/package/@swifttui/build)
![License](https://img.shields.io/badge/license-MIT-3DA639)

`@swifttui/build` turns a SwiftTUI app into the two artifacts the browser needs:
an `app.wasm` and a `scene-manifest.json`. It drives the Swift toolchain, runs a
browser `WebAssembly.compile` validation pass, and packages the result. It
is separate from [`@swifttui/web`](https://www.npmjs.com/package/@swifttui/web),
the browser runtime. Thus, runtime imports do not include Swift processes, Node
filesystem APIs, or wasm packaging helpers.

- **Runtime counterpart:** [`@swifttui/web`](https://www.npmjs.com/package/@swifttui/web)
  — mounts the artifacts this package produces.
- **Reference template:** [`swift-tui-examples/WebExample`](https://github.com/SwiftTUI/swift-tui-examples/tree/main/WebExample)
- **The framework:** [`SwiftTUI/swift-tui`](https://github.com/SwiftTUI/swift-tui)

## Installation

Install the ESM package from npm. The package includes a Node CLI and bundled
TypeScript declarations:

```bash
npm install --save-dev @swifttui/build
```

This exposes the `swifttui-web` CLI (`npx swifttui-web build --app <Exe>`) and a
programmatic ESM API. The package contains compiled JavaScript in `dist/`. The
binary runs on Node (`#!/usr/bin/env node`). You do not need Bun or a TypeScript
toolchain to use it. To compile a SwiftTUI app to wasm, install Swift 6.3.x and
the `swift-6.3.3-RELEASE_wasm` SDK.

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
- SDK: `swift-6.3.3-RELEASE_wasm`
- Release Swift flags:
  `-Xswiftc -Osize -Xswiftc -Xfrontend -Xswiftc -disable-llvm-merge-functions-pass`
- Initial memory: `536870912`
- Max memory: `4294967296`
- Stack size: `16777216` (16 MiB — the earlier 1 MiB default overflowed the
  wasm linear-memory stack in deep scenes)

Callers can override `swiftCommand`, `swiftSDK`, `configuration`,
`initialMemory`, `maxMemory`, `stackSize`, `extraSwiftcFlags`,
`extraLinkerFlags`, and `extraSwiftBuildArgs`.

> The WASI release flags (`-Osize` plus `-disable-llvm-merge-functions-pass`)
> keep the output under the browser `WebAssembly` API's 1000-parameter limit.
> The canonical command is in this package. Use the CLI or API instead of a
> separate `swift build` command.

## Developing this package

> This section applies only to work **on** `@swifttui/build`. A project that
> uses the package needs only the `npm install --save-dev` command above.

Use Bun for the CLI, bundling, and tests. Use `swiftly` Swift 6.3.3 for the wasm
build. Do not use bare `swift`.

- `bun test`
- `bun run build` — Compile the publishable package to `dist/` with tsdown.
  The output contains ESM `.js`, `.d.ts`, and the `swifttui-web` binary.
  `prepublishOnly` runs this command during publication.
- `bun run build:manifest -- --app <AppExecutable>`
- `bun run build:wasm -- --app <AppExecutable>`

The full app pipeline (manifest + wasm) is exposed through the CLI:

```bash
bun run cli.ts build --app <AppExecutable>    # from source
npx swifttui-web build --app <AppExecutable>  # from the published bin
```

## License

MIT — see [LICENSE](LICENSE).
