# Browser / WASI preview-readiness journey

This directory contains the direct Chrome journey for the public browser host.
It first builds the publishable packages, then serves a cross-origin-isolated
fixture that imports `packages/web/dist/index.js`. The fixture connects the
public `WebHostSceneRuntime` to the public `BrowserWASIBridge`; it does not
replace either layer with the fake DOM or recording-canvas controls used by the
unit tests.

Run it from the repository root:

```bash
bun run test:browser
```

The default Playwright project launches the installed branded Google Chrome.
Set `SWIFTTUI_BROWSER_EXECUTABLE` to an explicit Chrome-compatible executable
when the standard channel is installed elsewhere. The run writes its JSON
result, screenshot attachment, and any failure trace below the ignored
`.build/browser-journey/` directory.

Set `SWIFTTUI_BROWSER_JOURNEY_PORT` to move both the fixture server and
Playwright client from their default port of `4173`; the value must be an
integer from 1 through 65535.

The journey proves the current host cut through actual browser events and
pixels:

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
