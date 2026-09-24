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

`CompiledWasm.browser.ts` executes the two counter scenes in `Fixtures/BrowserApp`,
which also contains two performance probes and an accessibility control scene. The app is pinned to the public HTTPS
`swift-tui` tag **0.14.0**, with transitive
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

The accessibility scene includes a **Focus Name** button that sets Swift
`@FocusState`, and visible **Decorative star / Decorative dot** text inside an
`accessibilityHidden()` group. These provide app-driven focus and hidden-subtree
observations for native accessibility inspection and screen-reader walkthroughs.

| Engine project | Required engine classification | Worker prerequisites | JSPI journey |
| --- | --- | --- | --- |
| Chromium | V8; full stack profile | Cross-origin isolation and SharedArrayBuffer | Run when both JSPI functions exist |
| Firefox | Gecko; lean stack profile | Cross-origin isolation and SharedArrayBuffer | Run when both JSPI functions exist |
| WebKit | JSC with sourceURL, otherwise unknown; lean profile | Cross-origin isolation and SharedArrayBuffer | Run when both JSPI functions exist |

The capability test records the browser version, engine probe and both JSPI
function types. A missing capability produces an explicit skipped main-thread
test with a reason; an available capability must pass the entire journey.
Skips do not count as JSPI execution evidence. The main-thread journey also
requires zero workers, so a worker fallback cannot pass it. These small
functional journeys do not qualify production responsiveness or change the
runtime's automatic execution-mode policy.

## Synthetic browser/WASI transport

`AccessibilityActions.browser.ts` checks typed assistive requests and value
acknowledgements, plus actual browser bounds for nested controls and native
inputs on both canvas and DOM surfaces. Moving or hiding a semantic parent
preserves scene-space child bounds, and the transparent overlay leaves pointer
hit testing on the painted surface. These checks do not observe a screen
reader's own focus outline.

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

`AccessibilityActions.browser.ts` drives the built public runtime through the
same bridge with a synthetic semantic frame. All three engines verify focus,
activation, adjustment, native input editing, acknowledgements, rejected-value
restoration, disabled nodes, removed listeners and update-echo suppression.
These protocol checks do not execute Swift or listen to a screen reader.
The public Swift fixture remains pinned to 0.14.0; action acceptance against an
unreleased framework is coordination-owned until a released tag is adopted.

## Semantic presentation boundary

| Checklist item | 0.9 browser status | Journey evidence |
| --- | --- | --- |
| Reading order | Presented | Ordered `data-accessibility-id` tree |
| Names and roles | Presented | `tablist`, `tab`, `textbox`, `status`, and `img` attributes |
| Focus visibility | Runtime-origin only | Focused editor node and `focusPresentation` |
| Live announcements | Presented | Polite counter announcement |
| Hidden content | Presented | Inactive panel is absent from the ARIA tree |
| Text cursor anchoring | Wire-only | `cursorAnchor` is transported but has no browser DOM projection |
| Assistive activation, adjustment, editing, value/state, and assistive-origin focus | Supported when runtime action metadata is available | Separate adapter checks below; this presentation journey does not prove compiled-runtime or AT acceptance |

## Animation-frame paint batching

`PaintBatching.browser.ts` drives the public runtime on the public WASI bridge
with a synthetic peer and lets each engine's own `requestAnimationFrame` paint.
For a 120-frame burst delivered in one task it asserts one paint against 119
for the same runtime under `paintScheduling: "synchronous"`, and that the
canvas pixels after the single unioned paint equal the pixels after painting
every frame — for one-cell deltas on a 20x6 grid and for full repaints of an
80x24 grid. It logs both runtimes' main-thread time as `PAINT-BATCHING`. A
second case moves a hyperlink between two frames and, inside the same task,
clicks both rows with pointer events that carry the engine's real mouse
pointer id (learned from a genuine `page.mouse.move`, since Firefox numbers
the mouse 0 and the others 1): the click resolves against the newest frame
while the pixels still show the previous one.

## Incremental Canvas pixel oracle

`CanvasDamage.browser.ts` imports the production Canvas painter through its own
fixture and compares each engine's actual pixel buffers after repeated partial paints
against a full repaint. Cases include translucent overlapping images, disjoint
damage, nonzero placement/clip origins, and device scales 1 and 2. It verifies
composition and clipping independently of the unit tests' recording contexts.
It also checks adding, changing, and removing italic glyphs at measured
monospace cell dimensions: full and partial paints produce the same pixels,
and glyph ink stays inside its declared span.

## DOM renderer acceptance

`DomSurface.browser.ts` exercises live Range identity during same-row and
other-row updates, restyles and resize; it also performs a real clipboard
round trip into a textarea in each browser. Copy shortcuts must pass through
the focused runtime unhandled. Linux WebKit does not dispatch keyboard copy
for a non-editable Range even on a plain page, so that platform invokes the
native browser copy command; all engines paste through the keyboard.
Changed/removed selected
text clears selection immediately. Native Alt/Option drag bypasses application
pointer capture. The geometry cases cover wide CJK/emoji cells, long monospace
runs, anchors and CSS zoom. SVG box/block/Braille backgrounds are decoded by the
browser and compared with Canvas's shared geometric rules at two non-square
cell sizes, with screenshots retained as attachments. SVG edge antialiasing has
a bounded tolerance; copy text remains the original Unicode sequence.

Browser chrome find is not controlled by Playwright's page API. Reproducible
manual check: open the DOM fixture (load `/dom-surface.js` from `/health`), press
Ctrl/Cmd-F, search `Select me`, and confirm the browser highlights the visible
text once. Run `domJourney.update("same-row")` and `domJourney.update("cosmetic")`
from the console and repeat; search `REPLACED!` after
`domJourney.update("selected")`. This checks native browser find rather than a
custom JavaScript search implementation. The automated selection/copy journey
is not claimed as browser-chrome find automation.

## Measured JSPI policy qualification

Run `SWIFTTUI_JSPI_QUALIFY=1 bun run test:browser:built JspiQualification` after
building the fixture. These performance samples are opt-in; default CI explicitly
skips them. The compiled fixture adds a 256-label animated scene and a
96-wrapper tree beside the two functional counters. The input workload performs
50 increments per sample; the deep-tree workload performs five (three samples
in either case). Each sample lasts at least three seconds. Tests retain CPU,
input-to-frame latency, heartbeat, delivered-frame, hidden/resume and teardown
measurements. CPU is the sum of cumulative process time for the browser process
tree beneath the Playwright worker, using `ps` on macOS/Linux; it includes browser
and automation overhead and is not a WASM instruction counter. On macOS, WebKit
XPC processes can escape the descendant tree, so WebKit CPU is incomplete and
cannot qualify a faster default. Performance
bounds decide policy in a dated report, not a flaky pass/fail CI threshold.
