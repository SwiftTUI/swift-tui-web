import { expect, test } from "@playwright/test";
import type {} from "./compiled-wasm.fixture.ts";

test("restricted and conflicting real-engine probes remain conservative", async ({
  page,
}, info) => {
  await page.goto("/compiled-wasm.html");
  await page.waitForFunction(() => !!window.__compiledWasm);
  const result = await page.evaluate(() =>
    window.__compiledWasm.probeVariants(),
  );
  for (const v of result.variants) {
    expect(v.engine).toBe("unknown");
    expect(v.stackLeanRecommended).toBe(true);
    expect(v.supportsJSPI).toBe(
      result.actual.wasmSuspendingType === "function" &&
        result.actual.wasmPromisingType === "function",
    );
  }
  expect(result.autoWorker).toBe("worker");
  expect(result.forcedWorker).toBe("worker");
  expect(result.forcedMain).toBe("main-thread");
  expect(result.autoWithoutSAB).toBe(
    result.variants[0]?.supportsJSPI ? "main-thread" : "worker",
  );
  await info.attach("engine-probes", {
    body: JSON.stringify(
      { version: page.context().browser()?.version(), ...result },
      null,
      2,
    ),
    contentType: "application/json",
  });
});

for (const isolated of [true, false]) {
  test(`auto execution with ${isolated ? "shared input" : "no SharedArrayBuffer"} preserves overrides and tears down`, async ({
    page,
  }, info) => {
    let workers = 0,
      closed = 0;
    page.on("worker", (worker) => {
      workers++;
      worker.on("close", () => closed++);
    });
    await page.goto(`/compiled-wasm.html${isolated ? "" : "?no-isolation"}`);
    await page.waitForFunction(() => !!window.__compiledWasm);
    const caps = await page.evaluate(
      () => window.__compiledWasm.snapshot().capabilities,
    );
    expect(caps.sharedArrayBuffer).toBe(isolated);
    test.skip(
      !isolated && !caps.supportsJSPI,
      "No SAB and no JSPI: no supported browser execution path",
    );
    await page.evaluate(() =>
      window.__compiledWasm.start("auto", "alpha", {
        SWIFTTUI_STACK_LEAN_PROFILE: "1",
        SWIFTTUI_LEAN_RETAINED_REUSE: "0",
      }),
    );
    await page.waitForFunction(
      () => !!window.__compiledWasm.snapshot().frames.alpha,
    );
    const before = await page.evaluate(() => window.__compiledWasm.snapshot());
    expect(workers).toBe(isolated ? 1 : 0);
    expect(before.jspiStarts).toBe(isolated ? 0 : 1);
    expect(before.environments[0]).toMatchObject({
      SWIFTTUI_STACK_LEAN_PROFILE: "1",
      SWIFTTUI_LEAN_RETAINED_REUSE: "0",
    });
    await page.evaluate(() => window.__compiledWasm.suspend(true));
    await page.evaluate(() => window.__compiledWasm.dispose());
    await expect.poll(() => closed).toBe(workers);
    await page.waitForFunction(() => {
      const s = window.__compiledWasm.snapshot();
      return s.jspiStarts === s.jspiSettled;
    });
    const state = await page.evaluate(() => window.__compiledWasm.snapshot());
    expect(state.errors).toEqual([]);
    await info.attach("auto-execution", {
      body: JSON.stringify({
        version: page.context().browser()?.version(),
        ...state,
      }),
      contentType: "application/json",
    });
  });
}
