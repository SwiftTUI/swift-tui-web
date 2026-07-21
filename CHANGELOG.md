# Changelog

All notable changes to the `@swifttui/web` and `@swifttui/build` packages are
documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
follows pre-1.0 semantics: while the public surface is being proven, minor
releases may include source-breaking changes.

## [Unreleased]

## [0.1.12] - 2026-07-21

### Changed

- **Stack-lean profile default is OFF on confirmed V8 workers**
  (`stackProfileEnvironmentDefaults` → `SWIFTTUI_STACK_LEAN_PROFILE: "0"`
  iff `engine === "v8"`), exiting the 0.1.10 lean-everywhere hold. The
  hold's stated exit condition is met: the 0.1.9 coalescing was
  completed-frame disposal (fixed by 0.1.11's `async-no-cancel` render
  mode), not lean-vs-non-lean publication behavior, and the live
  non-lean + `async-no-cancel` combination measures the same
  distinct-generation coverage as lean at roughly half the per-frame
  pipeline cost. JSC stays lean (worker stack budget); Gecko stays lean
  by live measurement (its worker overflows the non-lean shape). The
  main-thread (JSPI) hold is unchanged pending a JSC main-thread soak
  and per-release Safari 27 depth-budget re-measurement. Overrides:
  `SWIFTTUI_STACK_LEAN_PROFILE` in the caller environment or the
  examples' `?leanProfile=` page seam.

## [0.1.11] - 2026-07-20

### Changed

- **`BrowserWASIBridge` now defaults `TERMUI_RENDER_MODE` to
  `async-no-cancel`** (engine-blind, both worker and main-thread execution
  modes). The 0.1.9 live coalescing was completed-frame *disposal* under
  supersession — visual-only drops (`dropped_completed`) plus pre-start
  cancels (`cancelled_before_start`) saturating at the starvation floor —
  not transport publication: on the single-threaded WASI drive, tick
  invalidations surface exactly where the async driver's supersession
  predicate samples. `async-no-cancel` keeps scheduler intent-merging as
  the backpressure valve but commits every completed frame; measured on
  the deployed Life scene it lifts distinct-generation coverage 0.22 →
  0.86 (worker) / 0.88 (main-thread) with per-frame cost unchanged, and
  live lean sessions measure zero drops/cancels, so the default is safe
  engine-blind. Callers and the examples' `?renderMode=` page seam
  override via `environment`; rollback is the one-line default.

## [0.1.10] - 2026-07-20

### Added

- **Main-thread (JSPI) wasm execution mode.** `MainThreadWasmExecutor` runs
  the app wasm on the main thread with `poll_oneoff` wrapped in
  `WebAssembly.Suspending` and `_start` via `promising`, backed by
  `MainThreadInputQueue` (no SharedArrayBuffer → no COOP/COEP requirement).
  Opt-in via the `executionMode: "main-thread"` factory option; `"auto"`
  (the default) selects it only when JSPI is available and SharedArrayBuffer
  is not — workers remain the auto default on JSPI-capable engines.

### Changed

- **Stack-lean defaults are held ON for every engine** (reverts 0.1.9's V8
  lean-off default). Under the non-lean profile, framework reuse gates
  coalesce per-tick frame emission — a worse live regression than lean's
  resolve cost. The hold's exit condition is framework-side per-tick frame
  emission under reuse. `stackLeanRecommended` is still reported for
  visibility; nothing applies it.
- **`@swifttui/build` default wasm linear-memory stack raised 1 MiB → 16 MiB**
  (`-z stack-size=16777216`). The 1 MiB default overflowed
  (`memory access out of bounds`) in deep non-lean scenes on every engine.

## [0.1.9] - 2026-07-20

### Added

- **`WasmEngineCapabilities`**: engine-family classification from Error
  mechanics (V8 `    at ` stack frames vs JSC/Gecko `fn@url` shapes; Gecko
  split by the `fileName` instance property, JSC by `sourceURL` with a
  stack-shape fallback for trunk WebKit) and JSPI capability detection
  (`supportsJSPI` requires both `WebAssembly.Suspending` and `promising`).
  `BrowserWASIBridge` injects engine-derived stack-profile environment
  defaults before caller overrides, and accepts injectable
  `engineCapabilities`.
- Engine-differentiated stack-lean default (V8 → non-lean). Reverted in
  0.1.10 — see above.

## [0.1.8] - 2026-07-20

Lockstep release across the SwiftTUI org; no changes to the web packages. The
release vehicle for `swift-tui`'s WASI depth-capped chunked resolve (the
Safari/WebKit worker stack-overflow fix), which ships to browsers through the
re-vendored bundle.

## [0.0.20 – 0.1.7] - 2026-06-16 – 2026-07-18

Backfilled summary (individual entries were not written at release time):

- **0.1.5** (2026-07-12): consume the F19 additive wire fields (hyperlinks,
  hidden, focus presentation, preferred grid) and add the version-skew guard
  with a shared canonical totality fixture (F57/F54).
- **0.1.0** (2026-06-24): split the `WebHostSceneRuntime` god-class into
  focused collaborators; keyed diff-and-reuse for the ARIA accessibility
  tree; code-quality fixes (wasm strip-failure restore, ring-buffer overflow
  handling).
- **0.0.23** (2026-06-19): default wheel mode to `"chain"` so embeds let the
  page scroll.
- Remaining tags (0.0.20, 0.0.21, 0.0.24–0.0.27, 0.1.1–0.1.4, 0.1.6, 0.1.7)
  were org lockstep releases with no functional web-package changes beyond
  packaging/publishing setup (npm provenance, release-tag publishing).

## [0.0.19] - 2026-06-10

Lockstep release across the SwiftTUI org (the Android host preview lands in
`swift-tui`; no functional changes to the web packages). `@swifttui/web` and
`@swifttui/build` attached to the GitHub `0.0.19` release as tarballs.

### Added

- `LICENSE` (MIT) at the repo root and inside both publishable packages
  (`packages/web`, `packages/build`) so the npm tarballs ship the license text
  they declare in `package.json`.
- README: a "See it running" link to the live browser demo
  (<https://swifttui.sh/webexample>) and the `WebExample` reference template, and
  a License section.

## [0.0.18] - 2026-06-07

- Lockstep release across the SwiftTUI org. `@swifttui/web` and
  `@swifttui/build` published to npm and attached to the GitHub `0.0.18` release
  as tarballs.

[Unreleased]: https://github.com/SwiftTUI/swift-tui-web/compare/0.1.10...HEAD
[0.1.10]: https://github.com/SwiftTUI/swift-tui-web/releases/tag/0.1.10
[0.1.9]: https://github.com/SwiftTUI/swift-tui-web/releases/tag/0.1.9
[0.1.8]: https://github.com/SwiftTUI/swift-tui-web/releases/tag/0.1.8
[0.0.19]: https://github.com/SwiftTUI/swift-tui-web/releases/tag/0.0.19
[0.0.18]: https://github.com/SwiftTUI/swift-tui-web/releases/tag/0.0.18
