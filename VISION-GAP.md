# Vision Gap

This document is the **only gap register** in this repository. Every other
document describes the code at `HEAD`. This document records differences
between the browser runtime and its intended state. Entries identify what is
**shipped today** and what is **not yet built**. The entries do not promise or
schedule work.

## Execution profile and performance

**Shipped.** The runtime has two execution modes. The worker mode uses
`Atomics.wait` stdin. The optional JSPI main-thread mode uses
`WebAssembly.Suspending`/`promising`. The runtime detects engine families from
Error behavior. It also detects JSPI support. The v3 delta wire applies deltas
to a cached baseline before consumers receive them. Canvas repaint is limited
to damaged areas.

**Not yet built.**

- **Non-lean defaults.** `stackProfileEnvironmentDefaults()` keeps the
  stack-lean profile on for every engine. A framework gap blocks a different
  default. This gap is in `swift-tui`. The framework must emit one frame per
  tick when it reuses content.
  Without the lean profile, reuse gates combine frame output for each tick.
  This behavior caused a Chromium regression in version 0.1.9. V8 has a
  measured non-lean pipeline improvement of approximately 2×. This mode and
  automatic JSPI main-thread selection remain disabled.
- **Frame pacing.** Each surface record starts a synchronous paint. The runtime
  does not batch paint operations with requestAnimationFrame. This batching
  is necessary before main-thread execution can become the default. In that
  mode, wasm and paint share one thread.
- **JSC detection hardening.** Trunk WebKit (STP ≥ 238) dropped the
  `sourceURL` Error property, so JSC classification rides only the
  `fn@url` stack-shape fallback. Unknown engines keep the lean profile. The
  detection needs an additional signal.

## Wire protocol robustness

**Shipped.** The version-skew guard reports frames that declare a newer
version. It does not silently degrade them. Delta validation uses text output
after baseline, dimension, or row mismatches.

**Not yet built.**

- **Late-join delta recovery.** A consumer can attach mid-stream and receive
  only v3 deltas. It renders nothing before the next full frame. The protocol
  has no baseline request or synchronization mechanism.
- **Sequence enforcement.** Frames carry `sequence` numbers but nothing
  enforces monotonicity or detects drops.

## Verification

**Shipped.** Headless `bun:test` suites cover the transport, engine features,
execution-mode selection, and scene runtime. The organization native gate runs
`bun run ci`.

**Not yet built.**

- **In-repo browser-engine coverage.** This repository CI does not run
  Playwright tests, browser tests, or performance budgets. The browser gates
  live in `swift-tui-examples/WebExample`: webkit-journey, frame-cadence, and
  raster-damage. The wasm scene-selection gate runs only on WebKit. It does not
  run on Chromium.
