import { expect, test } from "bun:test";

import { resolveWasmExecutionMode } from "./WasmSceneRuntime.ts";
import type { WasmEngineCapabilities } from "./WasmEngineCapabilities.ts";

function capabilities(
  overrides: Partial<WasmEngineCapabilities>
): WasmEngineCapabilities {
  return {
    engine: "v8",
    supportsJSPI: false,
    stackLeanRecommended: false,
    ...overrides,
  };
}

test("explicit preferences bypass detection", () => {
  const jsc = capabilities({ engine: "jsc", supportsJSPI: true });
  expect(resolveWasmExecutionMode("worker", jsc, true)).toBe("worker");
  expect(resolveWasmExecutionMode("main-thread", capabilities({}), true)).toBe(
    "main-thread"
  );
});

test("auto keeps workers on JSPI-capable JSC while non-lean emission is unproven", () => {
  expect(
    resolveWasmExecutionMode(
      "auto",
      capabilities({ engine: "jsc", supportsJSPI: true, stackLeanRecommended: true }),
      true
    )
  ).toBe("worker");
});

test("auto keeps workers where they already fit, or without JSPI", () => {
  expect(
    resolveWasmExecutionMode("auto", capabilities({ engine: "v8", supportsJSPI: true }), true)
  ).toBe("worker");
  expect(
    resolveWasmExecutionMode(
      "auto",
      capabilities({ engine: "jsc", supportsJSPI: false, stackLeanRecommended: true }),
      true
    )
  ).toBe("worker");
  expect(
    resolveWasmExecutionMode(
      "auto",
      capabilities({ engine: "gecko", supportsJSPI: true, stackLeanRecommended: true }),
      true
    )
  ).toBe("worker");
});

test("auto falls back to main-thread when SharedArrayBuffer stdin is unavailable", () => {
  expect(
    resolveWasmExecutionMode("auto", capabilities({ engine: "v8", supportsJSPI: true }), false)
  ).toBe("main-thread");
  expect(
    resolveWasmExecutionMode("auto", capabilities({ engine: "v8", supportsJSPI: false }), false)
  ).toBe("worker");
});
