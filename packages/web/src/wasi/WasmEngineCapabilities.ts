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
// Engine classification reads Error mechanics rather than user-agent
// strings: V8 formats stack frames as `    at fn (url)`, JSC and Gecko as
// `fn@url`, and the two are split by engine-specific Error instance
// properties (Gecko `fileName`, JSC `sourceURL`). Trunk WebKit (STP ≥ 238)
// no longer exposes `sourceURL` on constructed Errors, so JSC
// classification there rides the `fn@url` stack-shape fallback. Non-browser
// JSC hosts that emulate V8 stack frames for Node compatibility (e.g. Bun)
// classify as "v8"; the probe targets browser engines, where the formats
// don't cross.

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
    errorStack: typeof probe.stack === "string" ? probe.stack : "",
    errorHasGeckoFileName: "fileName" in probe,
    errorHasJSCSourceURL: "sourceURL" in probe,
    wasmSuspendingType: typeof wasm?.Suspending,
    wasmPromisingType: typeof wasm?.promising,
  };
}

export function classifyWasmEngineFamily(
  signals: WasmEngineProbeSignals
): WasmEngineFamily {
  if (/^\s*at /m.test(signals.errorStack)) {
    return "v8";
  }
  if (signals.errorHasGeckoFileName) {
    return "gecko";
  }
  if (signals.errorHasJSCSourceURL || /^[^\n]*@/m.test(signals.errorStack)) {
    return "jsc";
  }
  return "unknown";
}

export function resolveWasmEngineCapabilities(
  signals: WasmEngineProbeSignals = collectWasmEngineProbeSignals()
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
  capabilities: WasmEngineCapabilities
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
  if (capabilities.engine === "v8") {
    return { SWIFTTUI_STACK_LEAN_PROFILE: "0" };
  }
  return {};
}

/**
 * Environment defaults for the main-thread (JSPI) execution mode, where the
 * wasm runs on the page's thread and gets its far larger stack budget
 * (measured ~12.7× the worker's on trunk WebKit).
 */
export function mainThreadStackProfileEnvironmentDefaults(
  capabilities: WasmEngineCapabilities
): Record<string, string> {
  // HOLD: the main-thread (JSPI) stack budget fits non-lean on JSC and V8
  // (measured), but the JSC main-thread lane has not been soaked non-lean
  // in production, and JSPI slices the native stack — Safari 27's depth
  // budgets must be re-measured per release before this default can flip.
  // Callers can still force the profile via `SWIFTTUI_STACK_LEAN_PROFILE`.
  void capabilities;
  return {};
}

export interface JSPIConstructors {
  Suspending: new (fn: (...args: never[]) => unknown) => unknown;
  promising: (fn: unknown) => (...args: unknown[]) => Promise<unknown>;
}

/** Typed access to the JSPI surface, or undefined where unsupported. */
export function jspiConstructors(): JSPIConstructors | undefined {
  const wasm = globalThis.WebAssembly as unknown as Partial<JSPIConstructors> | undefined;
  if (
    typeof wasm?.Suspending === "function" &&
    typeof wasm?.promising === "function"
  ) {
    return wasm as JSPIConstructors;
  }
  return undefined;
}
