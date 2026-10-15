# `@swifttui/build`

**Build tooling for [SwiftTUI](https://swifttui.sh) browser deployments:
compile a SwiftTUI app to `wasm32-wasi` and capture its scene manifest.**

[![npm](https://img.shields.io/npm/v/@swifttui/build)](https://www.npmjs.com/package/@swifttui/build)
![License](https://img.shields.io/badge/license-MIT-3DA639)

`@swifttui/build` produces an `app.wasm` and a `scene-manifest.json`.
Canvas is the default; `--renderer dom` additionally packages the experimental
DOM host's font assets and license notice. It drives the Swift toolchain, runs a
browser `WebAssembly.compile` validation pass, and packages the result. It
is separate from [`@swifttui/web`](https://www.npmjs.com/package/@swifttui/web),
the browser runtime. Thus, runtime imports do not include Swift processes, Node
filesystem APIs, or wasm packaging helpers.

- **Runtime counterpart:** [`@swifttui/web`](https://www.npmjs.com/package/@swifttui/web),
  which mounts the artifacts this package produces.
- **Reference template:** [`swift-tui-counter-demo/WebExample`](https://github.com/SwiftTUI/swift-tui-counter-demo/tree/main/WebExample)
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
toolchain to use it. To compile a SwiftTUI app to wasm, install Swift 6.4.x and
the `swift-6.4.0-RELEASE_wasm` SDK.

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

For experimental DOM, pass `--renderer dom` to the command or `renderer: "dom"`
to `buildSwiftTUIWebApp`. That build copies the runtime package's four verified WOFF2 faces, their
manifest and OFL notice into `assets/swifttui-fonts/7d231a426067/`. Deploy that
directory with the app. Build systems that package WASM separately can use
`await copyDomFontAssets(outputDirectory)` from `@swifttui/build`; it validates
the installed asset hashes before copying. Runtime `domFont.assetBase` can
point at another same-origin asset directory. Font loading does not depend on
an external font service.

### Choose the browser renderer

The WASM/manifest build above is independent of browser JavaScript bundling.
For the standalone WebHost page, including a custom native app companion,
install Bun and run:

```sh
npx swifttui-web build:web --renderer canvas --dist browser
npx swifttui-web build:web --renderer dom --dist browser-dom
```

`build:web` needs no `--app`, Swift compiler, or WASM build. It produces
`index.html` and JavaScript with only the selected painter; the DOM variant also
includes its fonts and license. Omitting `--renderer` selects Canvas. Rebuilding
the same output directory replaces the previous presenter and removes DOM fonts
when selecting Canvas. Serve the entire directory. A native SwiftTUI app can
set `RuntimeConfiguration.browserAssetsPath` to that directory to use it for
both its accessibility companion and `--web` mode.

The API equivalent is:

```ts
import { buildBrowserBundle } from "@swifttui/build";
await buildBrowserBundle({ outputDirectory: "browser-dom", renderer: "dom" });
```

For a custom web page with its own bundler, set the bundler's compile-time
`SWIFTTUI_WEB_RENDERER` define to `JSON.stringify("canvas")` or
`JSON.stringify("dom")` and enable dead-code elimination. In Vite, for example:

```ts
export default {
  define: { SWIFTTUI_WEB_RENDERER: JSON.stringify("dom") },
};
```

Use `renderer: "dom"` in `createWebHostApp` (or omit it in a DOM-only build),
and package fonts with `build --renderer dom` or `copyDomFontAssets`.
Canvas-only builds need no DOM font copy. An unconfigured library bundle retains
both renderers for runtime selection and defaults to Canvas; the explicit build
define is what excludes the unused implementation. A single-renderer build
rejects requests for the other renderer, including URL or page configuration
overrides. DOM remains experimental; see the runtime's
[renderer guide](../web/README.md#renderers).

Toolchain defaults match the repo:

- Swift command: `swiftly run swift` when `swiftly` is on `PATH`, otherwise
  `swift`
- SDK: `swift-6.4.0-RELEASE_wasm`
- Release Swift flags:
  `-Xswiftc -Osize -Xswiftc -Xfrontend -Xswiftc -disable-llvm-merge-functions-pass`
- Initial memory: `536870912`
- Max memory: `4294967296`
- Stack size: `16777216` (16 MiB; the earlier 1 MiB default overflowed the
  wasm linear-memory stack in deep scenes)

Callers can override `swiftCommand`, `swiftSDK`, `configuration`,
`initialMemory`, `maxMemory`, `stackSize`, `extraSwiftcFlags`,
`extraLinkerFlags`, and `extraSwiftBuildArgs`.

> The WASI release flags (`-Osize` plus `-disable-llvm-merge-functions-pass`)
> keep the output under the browser `WebAssembly` API's 1000-parameter limit.
> The canonical command is in this package. Use the CLI or API instead of a
> separate `swift build` command.

## Developing this package

Development happens in the
[`swift-tui-web`](https://github.com/SwiftTUI/swift-tui-web) workspace, not
against the published tarball. The workspace commands and build pipeline are
documented in the repository's `docs/DEVELOPMENT.md` and
`packages/build/AGENTS.md`. The published CLI stays available as
`npx swifttui-web build --app <AppExecutable>`.

Full SwiftTUI API reference: <https://swifttui.sh/docs/documentation/>.

## License

MIT; see [LICENSE](LICENSE).
