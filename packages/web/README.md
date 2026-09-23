# `@swifttui/web`

**Browser runtime for [SwiftTUI](https://swifttui.sh) apps: draw a
Swift-authored UI into a `<canvas>` without a terminal emulator.**

[![npm](https://img.shields.io/npm/v/@swifttui/web)](https://www.npmjs.com/package/@swifttui/web)
![License](https://img.shields.io/badge/license-MIT-3DA639)

`@swifttui/web` is the browser host for SwiftTUI. A SwiftTUI app compiles to
`wasm32-wasi` and sends a structured raster surface on stdout. This package
loads the scene manifest and renders that surface in a canvas. It mounts an
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

One option selects between two surface presenters. Both presenters consume the
same frames:

```ts
await createWebHostApp({
  mount,
  manifestUrl,
  renderer: "dom", // "canvas" is the default
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
- **`"dom"`** renders cells as absolutely positioned text elements. It uses
  browser font shaping and fallback for emoji and CJK. Text stays sharp at each
  page zoom, and the element tree is inspectable. Hold Alt/Option and drag to
  select and copy app text. A drag without Alt/Option remains pointer input for
  the app. Box, block and Braille characters use cached SVG backgrounds from
  the Canvas geometry rules, with one original text node for selection/copy.
  Underline and strikethrough use CSS `text-decoration`; their patterns and
  SVG edge antialiasing can differ from Canvas. DOM metrics are measured in
  the styled mount and refreshed on font loading, style changes, resize,
  viewport zoom and DPR changes. `letter-spacing` aligns long monospace runs.

  Unchanged cell text nodes survive row damage, full paints, theme changes and
  resize. Changing/removing selected text, shrinking away its row, or changing
  its span into/out of a link clears the active selection and publishes the
  new data immediately. It never freezes app updates. Whitespace remains real
  text. Ctrl/Cmd-C copies the selection; Ctrl/Cmd-F remains browser find.

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

### Paint scheduling

Both renderers paint through `requestAnimationFrame`. Every surface frame the
runtime receives within one animation frame is painted once, as the newest
frame. The frames it supersedes are not lost: their damage is unioned onto the
paint (a change of grid size or epoch, or a frame without damage, makes it a
full repaint), an image payload that only a coalesced frame carried is spliced
into the painted frame, and their accessibility announcements are delivered in
order with the paint. Frames are still decoded and applied in transport order;
only the paint is deferred.

Two clocks follow from this, and each piece of runtime state follows one of
them:

- **On receipt:** pointer geometry (link targets, wheel-chaining scroll
  regions, the hit-testing grid), `preferredGridSize`, and
  `focusPresentation`. Input is routed to an app that already lives in the
  newest frame, so it is resolved against that frame.
- **With the paint:** the visible surface and the ARIA sidecar (tree, focus,
  live regions), so assistive technology describes what is on screen.

Resizes, restyles, and a document that becomes visible again paint
synchronously and fully; disposing a runtime cancels its pending paint.

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
