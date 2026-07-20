// Runtime detection of the browser's JS/wasm engine family and the wasm
// capabilities that decide how the SwiftTUI WASI runtime should execute.
//
// JavaScriptCore runs wasm calls on the host thread's native stack, and
// Darwin worker threads get ~1/16 of the main-thread stack budget, so
// SwiftTUI's WASI build defaults to its stack-lean resolve profile
// (`SWIFTTUI_STACK_LEAN_PROFILE`, depth-capped chunked resolve). That profile
// costs steady-state pipeline time, and engines with roomy worker stacks
// don't need it. Detection is deliberately asymmetric: a wrongly applied lean
// profile only costs speed, while wrongly disabling it on JSC overflows the
// wasm stack and kills the app — so lean stays recommended unless the engine
// is confidently V8 (the only family with a measured, comfortable worker
// budget). Gecko is kept on the lean profile until its worker wasm stack
// budget is measured.
//
// Engine classification reads Error mechanics rather than user-agent
// strings: V8 formats stack frames as `    at fn (url)`, JSC and Gecko as
// `fn@url`, and the two are split by their engine-specific Error instance
// properties (Gecko `fileName`, JSC `sourceURL`). Non-browser JSC hosts that
// emulate V8 stack frames for Node compatibility (e.g. Bun) classify as
// "v8"; the probe targets browser engines, where the formats don't cross.

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
   * `WebAssembly.promising`). When true, a future main-thread execution path
   * can suspend on stdin instead of blocking a worker on `Atomics.wait`.
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
  if (capabilities.stackLeanRecommended) {
    return {};
  }
  return { SWIFTTUI_STACK_LEAN_PROFILE: "0" };
}
