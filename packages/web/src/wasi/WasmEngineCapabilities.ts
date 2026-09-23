// Runtime detection of the browser's JS/wasm engine family and the wasm
// capabilities that decide how the SwiftTUI WASI runtime should execute.
//
// JavaScriptCore runs wasm calls on the host thread's native stack, and
// Darwin worker threads get ~1/16 of the main-thread stack budget, so
// SwiftTUI's WASI build defaults to its stack-lean resolve profile
// (`SWIFTTUI_STACK_LEAN_PROFILE`, depth-capped chunked resolve). That profile
// costs steady-state pipeline time, and engines with roomy worker stacks
// don't need it. Detection is deliberately asymmetric: a wrongly applied lean
// profile only costs speed, while wrongly disabling it on a small-stack
// engine overflows the wasm stack and kills the app — so lean stays
// recommended unless the engine is confidently V8, the only family with a
// measured, comfortable worker budget. Gecko is measured (Firefox, live,
// 2026-07) to NOT fit the non-lean shape in its worker: it must keep the
// lean profile in worker mode.
//
// Error metadata is advisory and non-standard. Conflicting markers or shared
// @-style stacks without an engine-specific marker classify as unknown. In
// particular, sourceURL-free WebKit stays conservative rather than relying on
// the absence of Gecko's optional fileName property as positive JSC evidence.
// JSPI detection is independent of this diagnostic engine label.

export type WasmEngineFamily = "v8" | "jsc" | "gecko" | "unknown";

export interface WasmEngineProbeSignals {
  errorStack: string;
  errorHasGeckoFileName: boolean;
  errorHasJSCSourceURL: boolean;
  wasmSuspendingType: string;
  wasmPromisingType: string;
}

export interface WasmEngineCapabilities {
  engine: WasmEngineFamily;
  /**
   * WebAssembly JavaScript Promise Integration (`WebAssembly.Suspending` +
   * `WebAssembly.promising`). When true, the main-thread execution mode
   * (`MainThreadWasmExecutor`) can suspend on stdin/timers instead of
   * blocking a worker on `Atomics.wait`.
   */
  supportsJSPI: boolean;
  /**
   * Whether the SwiftTUI WASI build should keep its stack-lean resolve
   * profile on this engine.
   */
  stackLeanRecommended: boolean;
}

export function collectWasmEngineProbeSignals(): WasmEngineProbeSignals {
  const probe = new Error("wasm-engine-probe");
  const wasm = (
    globalThis as {
      WebAssembly?: { Suspending?: unknown; promising?: unknown };
    }
  ).WebAssembly;
  return {
    errorStack: readProbe(
      () => (typeof probe.stack === "string" ? probe.stack : ""),
      "",
    ),
    errorHasGeckoFileName: readProbe(() => "fileName" in probe, false),
    errorHasJSCSourceURL: readProbe(() => "sourceURL" in probe, false),
    wasmSuspendingType: readProbe(() => typeof wasm?.Suspending, "undefined"),
    wasmPromisingType: readProbe(() => typeof wasm?.promising, "undefined"),
  };
}

export function classifyWasmEngineFamily(
  signals: WasmEngineProbeSignals,
): WasmEngineFamily {
  const v8 = /^\s*at /m.test(signals.errorStack);
  const atFrames = /^[^\n]*@/m.test(signals.errorStack);
  const gecko = signals.errorHasGeckoFileName;
  const jsc = signals.errorHasJSCSourceURL;
  if (Number(v8) + Number(gecko) + Number(jsc) > 1 || (v8 && atFrames))
    return "unknown";
  if (v8) return "v8";
  if (gecko) return "gecko";
  if (jsc) return "jsc";
  return "unknown";
}

export function resolveWasmEngineCapabilities(
  signals: WasmEngineProbeSignals = collectWasmEngineProbeSignals(),
): WasmEngineCapabilities {
  const engine = classifyWasmEngineFamily(signals);
  return {
    engine,
    supportsJSPI:
      signals.wasmSuspendingType === "function" &&
      signals.wasmPromisingType === "function",
    stackLeanRecommended: engine !== "v8",
  };
}

/**
 * WASI environment defaults implied by the engine capabilities. Spread these
 * *before* caller-provided environment entries so an explicit
 * `SWIFTTUI_STACK_LEAN_PROFILE` (or a tuning override) always wins.
 */
export function stackProfileEnvironmentDefaults(
  capabilities: WasmEngineCapabilities,
): Record<string, string> {
  // V8 workers run non-lean by default: the measured worker stack budget
  // fits the full-depth resolve, and per-frame pipeline cost roughly
  // halves versus the lean profile. The 0.1.9 regression that forced the
  // lean-everywhere hold was NOT lean-vs-non-lean publication behavior —
  // it was completed-frame *disposal* under supersession (visual-only
  // drops + pre-start cancels saturating at the starvation floor), fixed
  // by the `async-no-cancel` render-mode default in `BrowserWASIBridge`;
  // live non-lean + async-no-cancel measures the same distinct-generation
  // coverage as lean at ~2x less per-frame CPU.
  //
  // JSC stays lean (Darwin worker threads get ~1/16 of the main-thread
  // stack). Gecko stays lean by *measurement*, not caution: Firefox live
  // (2026-07) overflows the non-lean shape in its worker.
  //
  // Lean engines additionally opt into retained reuse under the lean
  // profile (`SWIFTTUI_LEAN_RETAINED_REUSE`, swift-tui's bounded-depth
  // reuse program): a reuse hit short-circuits the resolve descent, so it
  // only ever *shallows* the frame relative to the lean baseline — the
  // stack-safety direction — while cutting the steady worker pipeline
  // measured 27.6 → 10.8 ms/frame on WebKit (2026-07-22 split A/B against
  // the granular-observation WebExample). Builds predating the flag simply
  // never read the variable. Caller-provided environment still wins (these
  // defaults are spread first).
  if (capabilities.engine === "v8") {
    return { SWIFTTUI_STACK_LEAN_PROFILE: "0" };
  }
  return { SWIFTTUI_LEAN_RETAINED_REUSE: "1" };
}

/**
 * Environment defaults for the main-thread (JSPI) execution mode, where the
 * wasm runs on the page's thread and gets its far larger stack budget
 * (measured ~12.7× the worker's on trunk WebKit).
 */
export function mainThreadStackProfileEnvironmentDefaults(
  capabilities: WasmEngineCapabilities,
): Record<string, string> {
  // HOLD: the main-thread (JSPI) stack budget fits non-lean on JSC and V8
  // (measured), but the JSC main-thread lane has not been soaked non-lean
  // in production, and JSPI slices the native stack — Safari 27's depth
  // budgets must be re-measured per release before this default can flip.
  // This adds no main-thread-specific profile override. The bridge's existing
  // engine defaults (including V8 non-lean) and explicit caller environment
  // still apply. The September 2026 qualification did not broaden defaults.
  void capabilities;
  return {};
}

export interface JSPIConstructors {
  Suspending: new (fn: (...args: never[]) => unknown) => unknown;
  promising: (fn: unknown) => (...args: unknown[]) => Promise<unknown>;
}

/** Typed access to the JSPI surface, or undefined where unsupported. */
export function jspiConstructors(): JSPIConstructors | undefined {
  const wasm = globalThis.WebAssembly as unknown as
    | Partial<JSPIConstructors>
    | undefined;
  if (
    typeof wasm?.Suspending === "function" &&
    typeof wasm?.promising === "function"
  ) {
    return wasm as JSPIConstructors;
  }
  return undefined;
}

function readProbe<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}
