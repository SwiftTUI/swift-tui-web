# `@swifttui/web`

**Browser runtime for [SwiftTUI](https://swifttui.sh) apps: draw a
Swift-authored UI through Canvas or an experimental DOM renderer.**

[![npm](https://img.shields.io/npm/v/@swifttui/web)](https://www.npmjs.com/package/@swifttui/web)
![License](https://img.shields.io/badge/license-MIT-3DA639)

`@swifttui/web` is the browser host for SwiftTUI. A SwiftTUI app compiles to
`wasm32-wasi` and sends a structured raster surface on stdout. This package
loads the scene manifest and renders that surface using Canvas by default, or
DOM with `renderer: "dom"`. It mounts an
ARIA tree for accessibility and sends input to the running app. Thus, the same
view code runs in a terminal and on a web page. The package does not load a
terminal emulator.

The build side (compiling your Swift app to wasm and capturing its manifest)
lives in the sibling
[`@swifttui/build`](https://www.npmjs.com/package/@swifttui/build) package.

- **Live demo:** <https://swifttui.sh/webexample>
- **Reference template:** [`swift-tui-counter-demo/WebExample`](https://github.com/SwiftTUI/swift-tui-counter-demo/tree/main/WebExample)
  (≈60 lines of embedding code)
- **The framework:** [`SwiftTUI/swift-tui`](https://github.com/SwiftTUI/swift-tui)

## Installation

The package publishes to npm as ESM with bundled TypeScript declarations, so
no TypeScript toolchain is necessary to use it:

```bash
npm install @swifttui/web
```

The package contains compiled JavaScript and declarations in `dist/`
(`.js` + `.d.ts`). You do **not** need Bun or a TypeScript build step. Subpath entry points
(`./wasi`, `./wasi-worker`, `./manifest`, `./websocket`, `./testing`) and the
`./style.css` asset are declared in `package.json` `exports`.

## Assistive control actions

When a runtime publishes `actionTarget` and `actions`, the ARIA sidecar sends
node-targeted focus, activation, increment/decrement and typed value requests
through the scene's existing WebSocket or WASI input channel. Toggle checked
state, disclosure expansion, numeric ranges, disabled state and nonsecure text
come from runtime frames. Text fields/editors and numeric controls use native
browser inputs. Secure fields use password inputs and never receive their text
from a frame; local drafts clear on blur.

Semantic elements keep the same scene-space bounds as the painted controls,
including nested groups and native inputs, so assistive focus outlines align
with the canvas or DOM surface. The overlay is transparent and lets ordinary
pointer input reach the painted surface; only the announcement sink uses a
clipped screen-reader-only box.

Requests carry increasing scene-local IDs. Returned acknowledgements let the
host retain newer edits while older frames arrive, then reconcile to the
runtime's accepted or rejected state. Runtime focus and value updates do not
emit new requests. Removed/replaced elements cannot dispatch through stale
listeners. Runtimes without action metadata retain the presentation-only
sidecar, including the currently pinned 0.15.0 browser fixture.

`encodeAccessibilityActionMessage` and the exported action/value types expose
the same input format for custom hosts. Tokens and request IDs belong to the
scene runtime; discard them when that runtime closes. See the framework's
[accessibility contract](https://github.com/SwiftTUI/swift-tui/blob/main/docs/ACCESSIBILITY.md)
for supported controls and rejection results.

## API

```ts
import { createWebHostApp } from "@swifttui/web";

const controller = await createWebHostApp({
  mount: document.getElementById("app")!,
  manifestUrl: new URL("./scene-manifest.json", import.meta.url),
  style: {
    palette: {
      foreground: "#eceff4",
      background: "#1e222a",
      cursor: "#56b6c2",
      selectionBackground: "#2e3440",
      selectionForeground: "#eceff4",
    },
    theme: {
      foreground: "#eceff4",
      background: "#1e222a",
      tint: "#56b6c2",
      link: "#5ba3ff",
    },
  },
});

await controller.switchScene("dashboard");
controller.setStyle({ cursorBlink: true, theme: { tint: "#79c0ff" } });
```

For a static WASI-hosted app, use the WASI subpath:

```ts
import { createWasmSceneRuntimeFactory } from "@swifttui/web/wasi";
```

Worker entrypoints can delegate to:

```ts
import { startWasmSceneWorker } from "@swifttui/web/wasi-worker";

startWasmSceneWorker();
```

The page that hosts the WASI runtime must serve
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` so the `SharedArrayBuffer`-backed
stdin works.

## Renderers

**The DOM renderer is experimental.** It is opt-in, has known native-find and
performance limitations, and is not a production-qualified or WCAG-conformant
host profile. Canvas remains the default. The APIs and behavior described here
are the state of this repository's HEAD; released 0.15.1 has the earlier DOM
presenter with system fonts, without the packaged font and correlated-geometry
features below. In that release the semantic sidecar's bounds can lag the
visible DOM layout after resize, although pointer input on the visible control
and keyboard activation still work in the counter demo.

One option selects between two surface presenters. Both presenters consume the
same frames:

```ts
await createWebHostApp({
  mount,
  manifestUrl,
  renderer: "dom", // Experimental; "canvas" is the default.
});
```

- **`"canvas"`** (default) paints cells on one 2D `<canvas>` DOM node. It draws
  exact box seams and decoration patterns. Each declared cell span owns its
  glyph and decoration pixels: ink is clipped to that span on both full and
  incremental paints. Italic or fallback-font overhang that previously escaped
  a span on full paints is now clipped, so changing or removing a cell leaves
  no stale pixels in its neighbors. This is a rendering behavior change;
  authored spans and public API signatures are unchanged.
  Canvas preserves the selected font's glyph size and hard-clips oversized
  fallback glyphs; it does not scale them to fit. This differs from the Apple
  host's scale-to-fit fallback. If a browser font makes a declared single-cell
  glyph wider than one cell, its excess ink is truncated. Select a font whose
  fallback metrics fit the grid when that distinction matters.
- **`"dom"` (experimental)** renders fixed-width lead cells in absolutely positioned rows. It uses
  browser font shaping and fallback for emoji and CJK. Text stays sharp at each
  page zoom, and the element tree is inspectable. Hold Alt/Option and drag to
  select and copy app text. A drag without Alt/Option remains pointer input for
  the app. Box, block and Braille characters use cached SVG backgrounds from
  shared renderer-neutral geometry, with one original text node for selection/copy.
  Underline and strikethrough have independent color and geometry in the same
  SVG background: solid, dot, dash, dash-dot, dash-dot-dot, double and curly.
  SVG edge antialiasing can differ from Canvas. DOM metrics are measured in
  the styled mount and refreshed on font loading, style changes, resize,
  viewport zoom and DPR changes. Each wire lead keeps its original Unicode
  text and declared span in an integral CSS cell box; no advance correction,
  grapheme splitting or Canvas measurement is used in DOM mode.

  Unchanged cell text nodes survive row damage, full paints, theme changes and
  resize. Changing/removing selected text, shrinking away its row, or changing
  its span into/out of a link clears the active selection and publishes the
  new data immediately. It never freezes app updates. Whitespace remains real
  text, including sparse gaps and leading/trailing spaces. Copy writes the
  selected original Unicode once, with LF between rows; wide continuation
  columns add no second grapheme. WebKit may normalize decomposed text when
  reading the native clipboard back into a page; the copied clipboard text
  preserves it. Ctrl/Cmd-C copies the selection; Ctrl/Cmd-F remains browser find.
  Chromium currently cannot match a search across separate wire cells
  (its find engine treats inline-blocks as boundaries). Firefox and WebKit
  can. This is an explicit native-find limitation, not a production conformance
  claim. Find and print cover the mounted viewport only, never an offscreen virtual
  collection. The companion `style.css` print rules preserve the committed
  grid and hide semantic helpers and diagnostic output. Reflow/scrolling that
  replaces selected cells clears the Range; repeated text is not an identity.

  Protocol links use native anchors with safe HTTP(S) navigation, a new tab
  and `noopener noreferrer`. The optional `onOpenHyperlink` hook handles
  activation (including custom schemes) once; those custom schemes never
  become navigable `href`s. Anchors retain browser context menus and modified
  clicks, bypass app pointer capture, and stay out of the tab order because
  the unchanged ARIA sidecar owns keyboard accessibility. Alt/Option dragging
  a link selects its text. Resolved styles and SVG backgrounds are cached per
  painter, bounded to 512 entries each, and invalidated by metric/theme changes.

The option is also available for each scene runtime through
`WebHostSceneRuntimeOptions.renderer`. The package exports `DomSurfacePainter` for custom DOM runtimes.

### Experimental DOM quickstart

The renderer consumes the same Swift raster frames and WASM artifact as Canvas;
it does not translate a Swift view tree into browser flow layout. Size the mount
explicitly and include the package stylesheet:

```html
<div id="counter" style="width: 100%; height: 24rem"></div>
```

```ts
import { createWebHostApp, DOM_FONT_ASSET_PATH } from "@swifttui/web";
import { createWasmSceneRuntimeFactory } from "@swifttui/web/wasi";
import "@swifttui/web/style.css";

const output = new URL("./TerminalApp/dist/", import.meta.url);
const controller = await createWebHostApp({
  mount: document.getElementById("counter")!,
  manifestUrl: new URL("scene-manifest.json", output),
  renderer: "dom", // Experimental.
  style: { fontSize: 16 }, // Omit fontFamily to use the packaged DOM profile.
  domFont: { assetBase: new URL(DOM_FONT_ASSET_PATH, output) },
  sceneRuntimeFactory: createWasmSceneRuntimeFactory(
    new URL("assets/app.wasm", output),
    { workerModuleURL: new URL("./wasm-scene-worker.js", import.meta.url) },
  ),
});

window.addEventListener("pagehide", (event) => {
  if (!event.persisted) void controller.dispose();
});
```

Bundle `wasm-scene-worker.js` as an ESM entry point containing:

```ts
import { startWasmSceneWorker } from "@swifttui/web/wasi-worker";
startWasmSceneWorker();
```

Use `@swifttui/build` to generate the manifest/WASM and copy the font assets as
described below. Worker execution requires the existing WASI isolation headers;
renderer choice does not change that execution contract. A custom runtime
factory can instead use the same renderer with a WebSocket-backed Swift app.

The maintained [counter example](https://github.com/SwiftTUI/swift-tui-counter-demo/tree/main/WebExample)
provides `npm run build:dom`, `npm run dev:dom`, and a `/dom.html` page sharing
the ordinary counter artifact. Its bootstrap also supports released 0.15.1 by
detecting the packaged-font API rather than requiring it.

### Experimental support boundary

| Area | Current boundary |
| --- | --- |
| Presentation | Fixed cell allocation, clipped HTML text, SVG decorations and HTML images. No browser-flow re-layout or paragraph shaping across independent cells. |
| Native find | Chromium cannot find words spanning separate wire cells. Firefox and WebKit pass that case in the tested browser matrix. Single-cell find is insufficient evidence for general text. |
| Selection and print | Mounted viewport only. Alt/Option-drag selects; normal pointer gestures go to Swift. Replaced selected content clears selection. Offscreen content is not exported. |
| Accessibility | The shared semantic sidecar sends typed actions to Swift; visible text is not a second accessible control tree. The complete DOM control/AT journey and bounded WCAG claim are not qualified. IME/composition is outside the current input contract. |
| Browser evidence | Local automated checks cover Chromium 149, Firefox 151 and Playwright WebKit 26.5. They do not establish current stable Safari, Windows High Contrast/AT or physical iOS/Android acceptance. |
| Performance | Measured layout/paint-inclusive p95 misses the 8ms partial-update and 50ms large mixed-frame targets. A final thirty-minute soak and complete control-latency qualification are absent. |
| Mobile and preferences | Media-query emulation exists. Real Windows High Contrast and physical mobile interaction/AT are unqualified; emulation is not that evidence. |

Use the experimental renderer for evaluation and test it with your own content
and target browsers. The detailed behavior, asset policy, transform limits,
fallbacks, memory bounds and disposal semantics follow in this section.

### Images, preferences and resource ownership

DOM images use clipped placement wrappers in wire order above the cell layer,
matching the portable prepared-image contract. Repeated payload IDs may have
multiple placements. Reordering and restyling retain image nodes and sources;
removed/replaced images invalidate decode callbacks. Raw GIF containers display
only their first frame in both presenters. Authored `AnimatedImage` supplies
producer-selected PNG frames and follows WASI suspension and live reduced
motion. `style.reduceMotion` overrides the browser media-query preference;
explicit Swift runtime reduced motion remains authoritative.

Forced colors use system Canvas/CanvasText colors for text, geometric glyphs
and each decoration, with full ink opacity. Media-query changes invalidate
presentation and update the producer's motion preference. Windows High Contrast
and physical-device qualification are separate from browser emulation.

`runtime.resourceStatistics` exposes cells, row separators, image nodes,
semantic nodes, style/geometry caches, image bytes, pending/failed images,
font-face leases and paint-queue ownership. A painter retains at most one
row per admitted row, at most one cell per grid column (including sparse runs),
one separator between rows, and two elements per admitted image placement.
SVG decoration backgrounds add no DOM nodes. Rows/cells disappear with their
viewport content; semantic nodes correspond only to the current wire tree.

Each DOM painter admits at most 256 placements, 64 MiB decoded image bytes and
64 MiB retained payload characters measured as two-byte JavaScript units.
Rejected images produce a bounded visible diagnostic. Style and geometry
caches each hold at most 512 entries. A runtime leases four packaged font
faces, temporarily eight while replacing a visible font configuration; shared
configurations reuse document font resources. Disposal releases all leases.
The paint queue carries at most 64 MiB image bytes for IDs still referenced by
its candidate; missing bytes use the existing bounded recovery protocol.
Pending announcements are limited to 1,024 messages / 256 KiB. Exceeding that
limit stops the session visibly instead of silently losing assistive output.
WebSocket disconnected input is limited to 1,024 records / 1 MiB, and output
before binding to 256 records / 16 MiB. Exceeding either stops the session;
reloading starts a new one. These limits supplement the host-wire record and
grid bounds, rather than changing them.

### DOM typography and embedding

DOM mode defaults to the four bundled Source Code Pro faces (regular, bold,
italic and bold italic), with synthesis and discretionary ligatures disabled.
The unmodified WOFF2 files total 273,700 bytes. Their exact upstream release,
SHA-256 hashes and SIL Open Font License are included under `fonts/` in this
package. `@swifttui/build` copies them into
`assets/swifttui-fonts/2184c1f2bac4/` beside an app's output. Custom build systems
can call its `copyDomFontAssets(outputDirectory)` API. Serve these assets from
your origin; no external font service is required. The runtime resolves the
directory against `document.baseURI`. For a different deployment layout, set
`domFont: { assetBase: new URL("./fonts/", import.meta.url) }` on the app or
scene runtime.

The first coherent DOM presentation waits for all four faces, concurrently
with app startup, for at most two seconds by default. `domFont.timeoutMs`
configures that wait (capped at ten seconds). While waiting, the mount exposes
a loading status. Failure chooses and measures Menlo, Consolas, Liberation
Mono or the platform monospace fallback once and reports a diagnostic. A late
preferred font cannot replace that session's fallback. An explicit style
change or remount starts a new font transaction. Multiple embeds share loaded
faces in the same document; disposal releases only the disposing embed's
ownership. A supplied `style.fontFamily` opts into the embedder's custom font
and its fallback stack.
`runtime.fontReady` resolves the active transaction's readiness/fallback result;
`runtime.fontStatus` exposes its settled result. `runtime.geometrySnapshot`
exposes the current immutable CSS geometry for host diagnostics.

Under a Content Security Policy, allow the selected asset origin in `font-src`
(normally `'self'`). The DOM presenter sets scoped CSS properties through the
element's `style` API, which is distinct from setting a raw style attribute
under [`style-src-attr`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/style-src-attr).
Its owned SVG glyph backgrounds and wire images require `img-src data:`.
Permit the embedder's own stylesheet through its chosen stylesheet policy.
These requirements are separate from the app's existing script, worker and
WASM policy. A blocked font follows the bounded fallback policy above; no
browser security setting needs to be disabled.

The typography corpus covers 12, 14, 16, 20, 24 and 32 CSS px. CJK falls back
through PingFang SC, Hiragino Sans and Noto Sans CJK SC; emoji falls back through
Apple Color Emoji, Segoe UI Emoji and Noto Color Emoji. Availability and artwork
depend on the OS. No CJK font is bundled. The line box includes measured
fallbacks, and ink is clipped to its declared span. The host preserves combining
clusters, emoji sequences and wire cell order. Paragraph bidi reordering and
contextual shaping across independent cells are outside this cell-wire profile;
Arabic/Indic paragraph fidelity requires a richer shared text contract.

Give the app mount a definite size through your stylesheet, flex/grid layout or
inline styles; the host preserves those sizing rules. The runtime measures the
mount's content box, preserving fractional origins
and subtracting borders/padding. Hidden or sub-cell mounts defer presentation
until measurable. CSS zoom and positive axis-aligned scale/translation are
supported; rotation, skew, reflection and perspective report an embedding
diagnostic and suspend geometry changes. CSS cell pitch stays independent of
device scale. Actual text enlargement remeasures pitch and requests layout.
Call `runtime.refreshGeometry()` after changing ancestor CSS that does not
otherwise trigger a resize observation. Oversized mounts use the wire's bounded
viewport (1,024 cells per axis and 65,536 total cells) with a diagnostic.

### Paint scheduling

Both renderers paint through `requestAnimationFrame`. Every surface frame the
runtime receives within one animation frame is painted once, as the newest
frame. The frames it supersedes are not lost: their damage is unioned onto the
paint (a change of grid size or epoch, or a frame without damage, makes it a
full repaint), an image payload that only a coalesced frame carried is spliced
into the painted frame, and their accessibility announcements are delivered in
order with the paint. Frames are still decoded and applied in transport order;
only the paint is deferred.

Canvas updates input routing on receipt and paints its surface and ARIA sidecar
together at the next animation frame. DOM updates input routing, text and ARIA
bounds together with the visible frame.

DOM hosts declare `geometryRevisions` and wait for a producer's revision-zero
acknowledgement before sending revision-bearing geometry or pointer records.
A capable producer captures the revision before layout and echoes it on every
full or delta frame. A resize or font change retains the old presentation until
the newest requested revision arrives; late old replies cannot replace it.
User text-size changes reproject the visible frame and its semantic bounds
together while waiting. `geometrySnapshot.sourceRevision` identifies its
producer layout; `projected: true` marks this temporary display. The matching
producer frame clears that marker. A wait longer than one second produces a
visible diagnostic; the terminal's `data-geometry-pending` attribute identifies
the outstanding revision.

Pointer events name the visible source geometry and are rejected by Swift if its
current request or applied interaction map has moved on. Changing geometry
cancels an active pointer gesture without activating its former target.

An older producer remains usable with legacy resize/input records, but does not
provide the correlated-geometry guarantee. Reconnecting resets correlation,
queued paints and decoder state; delayed Blob conversions cannot reach the next
session. Typography revisions are independent of transport `epoch`/`gen`.

Resizes and restyles paint a complete matching frame as soon as available.
A document becoming visible again remeasures before painting; disposal cancels
pending paints, font callbacks and socket work.

`WebHostAppOptions.paintScheduling` (forwarded to every scene runtime as
`WebHostSceneRuntimeOptions.paintScheduling`) accepts an animation-frame pair
(`{ requestAnimationFrame, cancelAnimationFrame }`) or `"synchronous"`, which
paints every frame as it arrives — the behavior before batching. A host with no
`requestAnimationFrame` paints synchronously. `WebHostSceneRuntime.paintStatistics`
reports frames presented, paints delivered, and frames coalesced.
`ManualAnimationFrameScheduler` from `@swifttui/web/testing` is a hand-ticked
pair for deterministic tests:

```ts
import { ManualAnimationFrameScheduler } from "@swifttui/web/testing";

const clock = new ManualAnimationFrameScheduler();
const runtime = new WebHostSceneRuntime({ ..., paintScheduling: clock });
// present frames …
clock.tick(); // paints them, once
```

## Surface transport

This package uses SwiftTUI's `web-surface` WASI transport. The Swift runner
emits structured raster-surface records on stdout, and the browser host draws
them with the configured renderer (canvas rects/text or DOM elements). It does
not load a terminal emulator and does not depend on `ghostty-web` or
`ghostty-vt.wasm`.

`web-surface` is the default `SwiftTUIWASI` browser transport. WebHost still
sets `SWIFTTUI_TRANSPORT=surface` explicitly so generated app environments are
self-describing.

Wire input is bounded to 4 MiB per UTF-8 record, a 1,024-cell axis and 65,536-cell
grid area, with bounded rows, styles, images, and recovery state. Over-budget
input retains the last valid frame and requests a deduplicated keyframe repair.
The shared [allocation policy](https://github.com/SwiftTUI/swift-tui/blob/main/docs/HOST-WIRE-CONTRACT.md#allocation-budgets)
defines exact units, framing recovery, and bitmap limits.

## Notes

- Scene switching is controller-managed and retains existing scene runtimes.
- Terminal styling is host-owned through `WebHostTerminalStyle`, which carries
  one active palette/theme pair plus the runtime payload sent into SwiftTUI.
- Hosts with multiple themes swap entire `WebHostTerminalStyle` objects. The
  library does not provide a built-in mode switcher.
- `BrowserWASIBridge` sets `SWIFTTUI_TRANSPORT=surface` and decodes surface
  frames before handing them to the canvas runtime.
- Hyperlink cells from the app use `links` and `linkTargets` on the frame. A
  click opens an `http(s)` target in a new tab. The `onOpenHyperlink` runtime
  option can open the target instead. A pointer cursor identifies linked
  cells. Accessibility nodes that the app marks `hidden` do not enter the ARIA
  tree. The runtime exposes the frame `focusPresentation` and
  `preferredGridSize` values to hosts.

## Developing this package

Development happens in the
[`swift-tui-web`](https://github.com/SwiftTUI/swift-tui-web) workspace, not
against the published tarball. The workspace commands and build pipeline are
documented in the repository's `docs/DEVELOPMENT.md` and
`packages/web/AGENTS.md`. An app that uses this package needs only
`npm install`; it does not need Bun or the Swift toolchain.

Full SwiftTUI API reference: <https://swifttui.sh/docs/documentation/>.

## License

MIT; see [LICENSE](LICENSE).

## Canvas image ownership and retention

Each scene's Canvas painter owns its decoded images. It retains up to 256
entries and approximately 64 MiB of decoded RGBA pixels, evicting inactive
images in least-recently-used order. The current paintable image set stays
pinned: it may exceed these soft limits until images leave the frame. This
avoids repeated decoding and payload recovery when the visible set exceeds the
cache budget. The estimate excludes browser-specific overhead and is not a
hard process-memory limit. Revisited evicted images use the existing image
payload recovery protocol. Images whose identifiers exceed the recovery limit
are never evicted: they stay retained until they are replaced or the scene is
disposed.

Scene disposal closes retained images and any obsolete decode that finishes
later. Custom `CanvasSurfacePainter` decoders transfer ownership of each result
and must not share a closable result with another owner. The painter supports
`maxDecodedImageCacheEntries` and `maxDecodedImageCacheBytes` for custom hosts.

Surface records require nonnegative integer grid dimensions no larger than
2,147,483,647, matching the Android host's grid representation. Malformed full
or delta records cannot replace the retained decoder baseline. This structural
constraint is separate from practical canvas-allocation and record-size limits.

### WASM execution and engine classification

`executionMode: "auto"` prefers a worker when shared input is available. Without
SharedArrayBuffer it selects main-thread execution only when both
`WebAssembly.Suspending` and `WebAssembly.promising` are functions. Explicit
`"worker"` and `"main-thread"` preferences remain available; caller environment
settings override profile recommendations.

Error stack metadata is advisory. Only unambiguous V8 signals disable the lean
profile by default; Gecko, JSC and unknown engines retain conservative defaults.
Conflicting markers and shared `@` stack frames without `sourceURL`/`fileName`
classify as unknown. Modern sourceURL-free WebKit therefore may report unknown.
This diagnostic label never substitutes for the independent JSPI capability
check. Main-thread non-lean qualification is separate from engine classification.
