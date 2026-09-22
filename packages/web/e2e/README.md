# Browser and compiled WASM journeys

Playwright runs the owned browser journeys in Chromium, Firefox and WebKit.
Every project uses the browser revision pinned by `@playwright/test` in
`bun.lock`. Fixtures import the built public package entry points in `dist/`
and are served with COOP/COEP headers.

Run it from the repository root:

```bash
bun install --frozen-lockfile
bunx playwright install --with-deps chromium firefox webkit
bun run test:browser
```

The full command builds both packages, compiles the Swift fixture and runs the
matrix. Compiling requires Node 24, Bun 1.3.14, swiftly with the repository's
`.swift-version` (6.4.0), the matching `swift-6.4.0-RELEASE_wasm` SDK, and
Binaryen 130 (`wasm-opt`). Swiftly supplies `llvm-objcopy`. Ubuntu CI installs
these using `.github/workflows/test.yml` and
`Scripts/install_browser_fixture_toolchain.sh`.

After building, run `bun run test:browser:built --project=webkit` to repeat one
engine without rebuilding the Swift app. Run `bun run build:browser-fixture`
again after changing its Swift sources, manifest or dependency lock. A missing
compiled fixture fails server startup with the rebuild command.

`SWIFTTUI_BROWSER_EXECUTABLE` overrides only the Chromium executable for local
diagnostics; leave it unset for the pinned CI matrix. JSON results, HTML reports,
state attachments, failure screenshots and retained failure traces go beneath
`.build/browser-journey/`. Open the report with
`bunx playwright show-report .build/browser-journey/report`.

CI builds one WASM artifact, then downloads those exact bytes into three
independent browser jobs (`fail-fast: false`). Each job uploads its reports even
on failure. Build output is uploaded separately; compiler/package failures are
distinguishable from browser/runtime failures.

Set `SWIFTTUI_BROWSER_JOURNEY_PORT` to move both the fixture server and
Playwright client from their default port of `4173`; the value must be an
integer from 1 through 65535.

## Compiled Swift WASM

`CompiledWasm.browser.ts` executes `Fixtures/BrowserApp`, a two-scene SwiftTUI
app pinned to the public HTTPS `swift-tui` tag **0.14.0**, with transitive
versions recorded in `Package.resolved`. `build-wasm-fixture.ts` calls the public
`@swifttui/build` entry point to capture the native scene manifest and compile,
optimize, strip and validate the WASI module. No sibling checkout or Bazel is
required, and the generated binary stays in `.build/`.

The journey uses `createWebHostApp`, `createWasmSceneRuntimeFactory` and
`startWasmSceneWorker`. Keyboard and pointer events increment Swift `@State`;
real stdout frames and the presented accessibility tree prove the result.
Alpha and Beta keep independent counters through repeated controller scene
switches. Disposal removes the host DOM and closes both browser workers, or
settles both actual JSPI export promises, including the hidden scene.

| Engine project | Required engine classification | Worker prerequisites | JSPI journey |
| --- | --- | --- | --- |
| Chromium | V8; full stack profile | Cross-origin isolation and SharedArrayBuffer | Run when both JSPI functions exist |
| Firefox | Gecko; lean stack profile | Cross-origin isolation and SharedArrayBuffer | Run when both JSPI functions exist |
| WebKit | JSC; lean stack profile | Cross-origin isolation and SharedArrayBuffer | Run when both JSPI functions exist |

The capability test records the browser version, engine probe and both JSPI
function types. A missing capability produces an explicit skipped main-thread
test with a reason; an available capability must pass the entire journey.
Skips do not count as JSPI execution evidence. The main-thread journey also
requires zero workers, so a worker fallback cannot pass it. These small
functional journeys do not qualify production responsiveness or change the
runtime's automatic execution-mode policy.

## Synthetic browser/WASI transport

`PreviewReadiness.browser.ts` connects the real `WebHostSceneRuntime` and
`BrowserWASIBridge` to a deterministic TypeScript transport peer. It does not
execute WASM. It checks actual browser events and pixels:

- key and pointer records cross the public WASI bridge;
- the ARIA tree has stable reading order, names, roles, hidden-content
  filtering, a live announcement, and runtime-origin focus;
- a `ResizeObserver` change reaches the WASI resize pipe;
- wheel input is captured while the published region can scroll and falls
  through to page scrolling at its lower boundary;
- two tab counters survive repeated Alpha → Beta → Alpha → Beta switches; and
- a decoded PNG is painted at 25% opacity, then repainted at 75% from a frame
  that repeats its image identity without `dataBase64`.

This is a browser-host/WASI-transport journey, not a second implementation of
the Swift view graph. The synthetic transport peer changes its frame in
response to the real wire input so the browser boundary stays deterministic;
Swift `TabView` archive behavior remains owned and tested in `swift-tui`.

## Semantic presentation boundary

| Checklist item | 0.9 browser status | Journey evidence |
| --- | --- | --- |
| Reading order | Presented | Ordered `data-accessibility-id` tree |
| Names and roles | Presented | `tablist`, `tab`, `textbox`, `status`, and `img` attributes |
| Focus visibility | Runtime-origin only | Focused editor node and `focusPresentation` |
| Live announcements | Presented | Polite counter announcement |
| Hidden content | Presented | Inactive panel is absent from the ARIA tree |
| Text cursor anchoring | Wire-only | `cursorAnchor` is transported but has no browser DOM projection |
| Assistive activation, adjustment, editing, value/state, and assistive-origin focus | Not supported | Not recorded as passing by this journey |

## Incremental Canvas pixel oracle

`CanvasDamage.browser.ts` imports the production Canvas painter through its own
fixture and compares each engine's actual pixel buffers after repeated partial paints
against a full repaint. Cases include translucent overlapping images, disjoint
damage, nonzero placement/clip origins, and device scales 1 and 2. It verifies
composition and clipping independently of the unit tests' recording contexts.
It also checks adding, changing, and removing italic glyphs at measured
monospace cell dimensions: full and partial paints produce the same pixels,
and glyph ink stays inside its declared span.
