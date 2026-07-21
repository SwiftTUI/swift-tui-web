import { expect, test } from "bun:test";

import { BrowserWASIBridge } from "./BrowserWASIBridge.ts";
import {
  classifyWasmEngineFamily,
  collectWasmEngineProbeSignals,
  resolveWasmEngineCapabilities,
  stackProfileEnvironmentDefaults,
  type WasmEngineProbeSignals,
} from "./WasmEngineCapabilities.ts";

function signals(
  overrides: Partial<WasmEngineProbeSignals>
): WasmEngineProbeSignals {
  return {
    errorStack: "",
    errorHasGeckoFileName: false,
    errorHasJSCSourceURL: false,
    wasmSuspendingType: "undefined",
    wasmPromisingType: "undefined",
    ...overrides,
  };
}

const v8Signals = signals({
  errorStack:
    "Error: probe\n    at collect (https://example.test/app.js:10:3)\n    at https://example.test/app.js:20:1",
});

const jscSignals = signals({
  errorStack:
    "collect@https://example.test/app.js:10:3\nglobal code@https://example.test/app.js:20:1",
  errorHasJSCSourceURL: true,
});

const geckoSignals = signals({
  errorStack:
    "collect@https://example.test/app.js:10:3\n@https://example.test/app.js:20:1",
  errorHasGeckoFileName: true,
});

test("stack frame shape and error markers classify the engine family", () => {
  expect(classifyWasmEngineFamily(v8Signals)).toBe("v8");
  expect(classifyWasmEngineFamily(jscSignals)).toBe("jsc");
  expect(classifyWasmEngineFamily(geckoSignals)).toBe("gecko");
  // JSC identified by @-frames alone when instance markers are unavailable.
  expect(
    classifyWasmEngineFamily(
      signals({ errorStack: "collect@https://example.test/app.js:10:3" })
    )
  ).toBe("jsc");
  expect(classifyWasmEngineFamily(signals({}))).toBe("unknown");
});

test("stack-lean stays recommended everywhere except confirmed V8", () => {
  expect(resolveWasmEngineCapabilities(v8Signals).stackLeanRecommended).toBe(
    false
  );
  expect(resolveWasmEngineCapabilities(jscSignals).stackLeanRecommended).toBe(
    true
  );
  expect(resolveWasmEngineCapabilities(geckoSignals).stackLeanRecommended).toBe(
    true
  );
  expect(
    resolveWasmEngineCapabilities(signals({})).stackLeanRecommended
  ).toBe(true);
});

test("JSPI requires both Suspending and promising", () => {
  expect(resolveWasmEngineCapabilities(v8Signals).supportsJSPI).toBe(false);
  expect(
    resolveWasmEngineCapabilities(
      signals({ wasmSuspendingType: "function", wasmPromisingType: "function" })
    ).supportsJSPI
  ).toBe(true);
  expect(
    resolveWasmEngineCapabilities(
      signals({ wasmSuspendingType: "function" })
    ).supportsJSPI
  ).toBe(false);
});

test("environment defaults disable lean only on confirmed V8", () => {
  expect(
    stackProfileEnvironmentDefaults(resolveWasmEngineCapabilities(v8Signals))
  ).toEqual({ SWIFTTUI_STACK_LEAN_PROFILE: "0" });
  // JSC: worker stack budget does not fit non-lean.
  expect(
    stackProfileEnvironmentDefaults(resolveWasmEngineCapabilities(jscSignals))
  ).toEqual({});
  // Gecko: measured live (2026-07) to overflow non-lean in its worker.
  expect(
    stackProfileEnvironmentDefaults(resolveWasmEngineCapabilities(geckoSignals))
  ).toEqual({});
  // Unknown engines keep the safe default.
  expect(
    stackProfileEnvironmentDefaults(resolveWasmEngineCapabilities(signals({})))
  ).toEqual({});
});

test("bridge applies engine defaults and lets caller environment win", () => {
  const v8Bridge = new BrowserWASIBridge({
    sceneId: "main",
    columns: 80,
    rows: 24,
    engineCapabilities: resolveWasmEngineCapabilities(v8Signals),
  });
  expect(v8Bridge.environment.SWIFTTUI_STACK_LEAN_PROFILE).toBe("0");

  const jscBridge = new BrowserWASIBridge({
    sceneId: "main",
    columns: 80,
    rows: 24,
    engineCapabilities: resolveWasmEngineCapabilities(jscSignals),
  });
  expect(jscBridge.environment.SWIFTTUI_STACK_LEAN_PROFILE).toBeUndefined();

  const overriddenBridge = new BrowserWASIBridge({
    sceneId: "main",
    columns: 80,
    rows: 24,
    engineCapabilities: resolveWasmEngineCapabilities(v8Signals),
    environment: { SWIFTTUI_STACK_LEAN_PROFILE: "1" },
  });
  expect(overriddenBridge.environment.SWIFTTUI_STACK_LEAN_PROFILE).toBe("1");
});

test("live probe collects without throwing and classifies to a known family", () => {
  const live = collectWasmEngineProbeSignals();
  expect(typeof live.errorStack).toBe("string");
  expect(["v8", "jsc", "gecko", "unknown"]).toContain(
    resolveWasmEngineCapabilities(live).engine
  );
});
