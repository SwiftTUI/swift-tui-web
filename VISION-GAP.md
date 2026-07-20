# Vision Gap

This document is the **only gap register** in this repository. Every other
document describes the code as it is at `HEAD`; this one records, concretely,
where the shipped browser runtime falls short of its intent. Entries state
what is **shipped today** and what is **not yet built**. Nothing here is
scheduled or promised — it is a gap register, not a roadmap.

## Execution profile and performance

**Shipped.** Two execution modes (worker with `Atomics.wait` stdin; opt-in
JSPI main-thread via `WebAssembly.Suspending`/`promising`), engine-family
detection from Error mechanics, JSPI capability detection, and the v3 delta
wire (deltas are materialized against a cached baseline before consumers see
them; canvas repaint is damage-scoped).

**Not yet built.**

- **Non-lean defaults.** `stackProfileEnvironmentDefaults()` holds the
  stack-lean profile ON for every engine. The exit condition is
  framework-side per-tick frame emission under reuse (a `swift-tui` gap):
  under non-lean, reuse gates coalesce per-tick frame emission, which
  regressed live Chromium in 0.1.9. Until then, V8's measured non-lean win
  (~2× pipeline) stays parked, as does auto-selecting main-thread execution
  on JSPI-capable engines.
- **Frame pacing.** Painting is synchronous per surface record — there is no
  requestAnimationFrame batching. Irrelevant at today's cadence, but a
  prerequisite for defaulting main-thread execution, where wasm and paint
  share the thread.
- **JSC detection hardening.** Trunk WebKit (STP ≥ 238) dropped the
  `sourceURL` Error property, so JSC classification rides only the
  `fn@url` stack-shape fallback. Fail-safe today (unknown engines keep
  lean), but the signal should be strengthened.

## Wire protocol robustness

**Shipped.** Version-skew guard (frames declaring a newer version raise a
runtime issue instead of degrading silently); delta validation falls back to
text on baseline/dimension/row mismatches.

**Not yet built.**

- **Late-join delta recovery.** A consumer that attaches mid-stream and
  receives only v3 deltas renders nothing until the next full frame; there is
  no baseline-request or resync mechanism.
- **Sequence enforcement.** Frames carry `sequence` numbers but nothing
  enforces monotonicity or detects drops.

## Verification

**Shipped.** Headless `bun:test` suites for the transport, engine
capabilities, execution-mode selection, and scene runtime; the org-level
native gate runs `bun run ci`.

**Not yet built.**

- **In-repo browser-engine coverage.** No Playwright/browser tests or perf
  budgets run in this repository's CI; the browser gates (webkit-journey,
  frame-cadence, raster-damage) live in `swift-tui-examples/WebExample`. A
  wasm scene-switch gate exists only on WebKit, none on Chromium.
