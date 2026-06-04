# `@swifttui/build`

Build-time package for SwiftTUI browser deployment.

This package owns manifest generation, Swift WASI builds, browser
`WebAssembly.compile` validation, and wasm packaging. It intentionally sits
outside `@swifttui/web` so browser runtime imports do not pull in Swift process
spawning, Node filesystem APIs, or wasm packaging helpers.

## Installation

Published to npm as an ESM package with a Node CLI and bundled TypeScript
declarations:

```bash
npm install --save-dev @swifttui/build
```

This exposes the `swifttui-web` CLI (`npx swifttui-web build --app <Exe>`) and a
programmatic ESM API. The package ships compiled `dist/` JavaScript — the bin
runs on plain Node (`#!/usr/bin/env node`), no Bun or TypeScript toolchain
required to consume it.

## API

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

## Scripts

- `bun test`
- `bun run build` — compile the publishable package to `dist/` with tsdown
  (ESM `.js` + `.d.ts`, plus the `swifttui-web` bin). Run automatically on
  publish via `prepublishOnly`.
- `bun run build:manifest -- --app <AppExecutable>`
- `bun run build:wasm -- --app <AppExecutable>`

The full app pipeline (manifest + wasm) is exposed through the CLI:

```bash
bun run cli.ts build --app <AppExecutable>   # from source
npx swifttui-web build --app <AppExecutable>  # from the published bin
```
