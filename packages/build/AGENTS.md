# AGENTS.md

Guidance for agentic assistants working in **`@swifttui/build`**. Keep this
concise; [`README.md`](README.md) is the full reference.

## What this package is

The **build/packaging tooling** for SwiftTUI browser apps — the sibling of
[`@swifttui/web`](../web) (which owns the runtime). It captures the Swift app's
scene manifest and packages its WASI/wasm artifact for the browser. Exposes the
`swifttui-web` CLI (see `bin` in `package.json`) and a programmatic `index.ts`.

Keep the split clean: **packaging/build steps live here; browser-safe runtime
APIs live in `@swifttui/web`.** This package depends on `@swifttui/web`.

## Toolchains

- **Bun** for the CLI, bundling, and tests.
- **`swiftly`** Swift 6.3.1 for the wasm build it invokes
  (`swiftly run swift ...`), not bare `swift`.

## Commands

```bash
bun test                         # package tests
bun run build:manifest -- --app <Exe>   # capture TUIGUI_MODE=manifest output
bun run build:wasm     -- --app <Exe>   # copy + validate the app's wasm
bun run build          -- --app <Exe>   # manifest + wasm
```

`build:wasm`/`build` default to `--configuration release`; pass
`--configuration debug` for local debug wasm.

## Gotcha

WASI release builds need specific flags (`-Osize` plus
`-disable-llvm-merge-functions-pass`) to stay under the browser WebAssembly
API's 1000-parameter limit. The canonical command lives in this package's build
code — don't hand-roll the swift invocation. See
[`WebExample`](../../../swift-tui-examples/WebExample) for the full rationale.

## Conventions

`AGENTS.md` is the real file; `CLAUDE.md` is a symlink to it. Edit `AGENTS.md`.
