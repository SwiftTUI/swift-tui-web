# AGENTS.md

Guidance for agentic assistants working in **`@swifttui/build`**. Keep this
file concise. [`README.md`](README.md) is the full reference.

## What this package is

This package contains the **build and packaging tools** for SwiftTUI browser
apps. [`@swifttui/web`](../web) contains the runtime. This package captures the
Swift app scene manifest. It also packages the WASI/wasm artifact for the
browser. It provides the `swifttui-web` CLI and a programmatic `index.ts` API.
See `bin` in `package.json` for the CLI entry point.

Keep packaging and build steps in this package. Keep browser-safe runtime APIs
in `@swifttui/web`. This package depends on `@swifttui/web`.

## Toolchains

- Use **Bun** for the CLI, bundling, and tests.
- Use **`swiftly`** Swift 6.3.3 for the wasm build
  (`swiftly run swift ...`). Do not use bare `swift`.

## Commands

```bash
bun test                                # package tests
bun run build                           # compile the publishable package to dist/ (tsdown: ESM .js + .d.ts + bin)
bun run build:manifest -- --app <Exe>   # capture SWIFTTUI_MODE=manifest output
bun run build:wasm     -- --app <Exe>   # copy + validate the app's wasm
bun run cli.ts build   -- --app <Exe>   # full app pipeline (manifest + wasm) via the CLI
```

`build` produces the published library and the `swifttui-web` binary.
`prepublishOnly` runs this command again during publication. The CLI `build`
command runs the full app pipeline. Use `bun run cli.ts build --app <Exe>` from
source. Use `npx swifttui-web build --app <Exe>` from the published binary.
`build:wasm` and the CLI `build` use `--configuration release` by default. Pass
`--configuration debug` for a local debug wasm build.

## Gotcha

WASI release builds need specific flags (`-Osize` plus
`-disable-llvm-merge-functions-pass`) to stay under the browser WebAssembly
API's 1000-parameter limit. The canonical command is in the build code of this
package. Do not write a separate Swift command. See
[`WebExample`](https://github.com/SwiftTUI/swift-tui-examples/tree/main/WebExample) for the full rationale.

## Conventions

`AGENTS.md` is the real file. `CLAUDE.md` is a symlink to it. Edit `AGENTS.md`.
