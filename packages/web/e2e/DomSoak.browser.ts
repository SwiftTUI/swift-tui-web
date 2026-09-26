import { expect, test } from "@playwright/test";
import type {} from "./compiled-wasm.fixture.ts";

// Per-action trace snapshots retain observation data during the run and would
// contaminate the retained-memory comparison. Keep only minute samples.
test.use({ trace: "off", screenshot: "off", video: "off" });

test.skip(
  process.env.SWIFTTUI_DOM_SOAK !== "1",
  "Set SWIFTTUI_DOM_SOAK=1 for the thirty-minute compiled DOM soak",
);
test("thirty-minute compiled DOM scroll, update, style and scene soak", async ({
  page,
  browserName,
}, info) => {
  test.skip(
    browserName !== "chromium",
    "The named reference soak uses Chromium post-GC page heap measurements",
  );
  test.setTimeout(35 * 60_000);
  let started = 0,
    closed = 0;
  page.on("worker", (worker) => {
    started++;
    worker.on("close", () => closed++);
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/compiled-wasm.html");
  await page.waitForFunction(() => !!window.__compiledWasm);
  await page.evaluate(async () => {
    window.__compiledWasm.resizeMount(1200, 1000);
    await window.__compiledWasm.start(
      "worker",
      "accessibility",
      undefined,
      "dom",
    );
  });
  const cdp = await page.context().newCDPSession(page);
  const samples: unknown[] = [];
  let count = 0;
  async function cycle(index: number) {
    await page.evaluate(() => window.__compiledWasm.switchScene("scrolling"));
    await expect(
      page.locator(".webhost-scene:visible .webhost-scene__surface-rows"),
    ).toContainText("Selected row");
    const box = await page
      .locator(".webhost-scene:visible .webhost-scene__surface--dom")
      .boundingBox();
    if (!box) throw new Error("Missing scrolling grid");
    await page.mouse.move(box.x + 100, box.y + 80);
    await page.mouse.wheel(0, index % 2 ? -120 : 120);
    await page.evaluate(
      (index) => window.__compiledWasm.setFontSize(index % 2 ? 18 : 16),
      index,
    );
    await page.evaluate(() => window.__compiledWasm.switchScene("images"));
    await expect(page.locator(".webhost-scene:visible img")).toHaveCount(1);
    await page.evaluate(() =>
      window.__compiledWasm.switchScene("accessibility"),
    );
    await page.evaluate(() => window.__compiledWasm.setFontSize(16));
    await page
      .getByRole("button", { name: "Activate", exact: true })
      .press("Enter");
    count++;
    await expect(
      page.getByLabel(`Activated ${count}`, { exact: true }),
    ).toBeAttached();
  }
  for (let i = 0; i < 10; i++) await cycle(i);
  const start = Date.now();
  async function sample() {
    await cdp.send("HeapProfiler.collectGarbage");
    const heap = await cdp.send("Runtime.getHeapUsage");
    const resources = await page.evaluate(() =>
      window.__compiledWasm.resources(),
    );
    const result = {
      elapsedMs: Date.now() - start,
      heap,
      resources,
      started,
      closed,
    };
    samples.push(result);
    console.log(JSON.stringify({ soakSample: result }));
    for (const painter of resources.painters) {
      expect(painter.styleCacheEntries).toBeLessThanOrEqual(512);
      expect(painter.geometryCacheEntries).toBeLessThanOrEqual(512);
    }
    return result;
  }
  const baseline = await sample();
  let index = 0,
    lastSample = Date.now();
  while (Date.now() - start < 30 * 60_000) {
    await cycle(index++);
    if (Date.now() - lastSample >= 60_000) {
      await sample();
      lastSample = Date.now();
    }
    await page.waitForTimeout(1000);
  }
  const final = await sample();
  const diagnostics = await page.evaluate(
    () => window.__compiledWasm.snapshot().errors,
  );
  // This workload deliberately changes typography while wheel input and
  // retained-scene frames are in flight. Rejection of obsolete geometry is
  // the negotiated safety contract, not a runtime failure. Retain every
  // diagnostic; all other warnings/errors remain failures below.
  const unexpectedDiagnostics = diagnostics.filter(
    (message) =>
      message !==
      "SwiftTUI runtime warning [host.geometry.stalePointer] from HostGeometry Pointer input from an obsolete host geometry was rejected.",
  );
  await page.evaluate(() => window.__compiledWasm.dispose());
  await expect.poll(() => closed, { timeout: 2000 }).toBe(started);
  const disposed = await page.evaluate(() => window.__compiledWasm.resources());
  await info.attach("dom-soak", {
    contentType: "application/json",
    body: JSON.stringify(
      {
        browser: page.context().browser()?.version(),
        durationMs: Date.now() - start,
        cycles: index,
        count,
        baseline,
        final,
        samples,
        disposed,
        errors,
        diagnostics,
        workers: { started, closed },
      },
      null,
      2,
    ),
  });
  // Compare the same scene/style after every scene and resource path warmed.
  expect(final.resources.nodes).toBeLessThanOrEqual(
    baseline.resources.nodes + 100,
  );
  expect(final.resources.fonts).toBe(baseline.resources.fonts);
  expect(final.resources.scenes).toEqual(baseline.resources.scenes);
  expect(final.heap.usedSize - baseline.heap.usedSize).toBeLessThan(
    10 * 1024 * 1024,
  );
  expect(
    final.heap.backingStorageSize - baseline.heap.backingStorageSize,
  ).toBeLessThan(10 * 1024 * 1024);
  expect(errors).toEqual([]);
  expect(unexpectedDiagnostics).toEqual([]);
  expect(disposed.nodes).toBe(0);
  for (const painter of disposed.painters)
    expect(Object.values(painter).every((value) => value === 0)).toBe(true);
});
