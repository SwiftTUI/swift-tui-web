import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import type {} from "./dom-performance.fixture.ts";

test.use({ trace: "off", screenshot: "off" });

// Opt-in measurements report against qualification budgets; CI machines do not
// acquire a performance guarantee by passing the correctness assertions here.
test("retained cell-DOM cost at five repeats", async ({
  page,
  browserName,
  browser,
}, info) => {
  test.skip(
    process.env.SWIFTTUI_DOM_PERF !== "1",
    "Run on the named reference machine with SWIFTTUI_DOM_PERF=1",
  );
  test.setTimeout(600_000);
  await page.setViewportSize({ width: 2440, height: 1960 });
  await page.goto("/health");
  await page.addScriptTag({ url: "/dom-performance.js", type: "module" });
  await page.waitForFunction(() => !!window.domPerformance);
  const cdp =
    browserName === "chromium"
      ? await page.context().newCDPSession(page)
      : undefined;
  let events: unknown[] = [];
  cdp?.on("Tracing.dataCollected", ({ value }) => events.push(...value));
  const results = [];
  let traceDataLost = false;
  for (let repeat = 0; repeat < 5; repeat++)
    for (const [width, height, partial] of [
      [120, 40, true],
      [120, 40, false],
      [240, 80, false],
    ] as const) {
      events = [];
      await cdp?.send("Tracing.start", {
        transferMode: "ReportEvents",
        traceConfig: {
          includedCategories: ["devtools.timeline", "blink.user_timing"],
          excludedCategories: ["*"],
          traceBufferSizeInKb: 262144,
        },
      });
      const result = await page.evaluate(
        ({ width, height, partial, repeat }) =>
          window.domPerformance.measure(width, height, partial, repeat),
        { width, height, partial, repeat },
      );
      expect(result.retainedIdentity).toBe(true);
      expect(result.exact).toBe(true);
      expect(result.counts.cells).toBeLessThanOrEqual(width * height);
      expect(result.counts.cells).toBeGreaterThanOrEqual(height);
      expect(result.disposedElements).toBe(0);
      results.push(result);
      await writeFile(
        info.outputPath("partial-measurements.json"),
        JSON.stringify(results),
      );
      if (cdp) {
        const complete = new Promise<void>((resolve) =>
          cdp.once("Tracing.tracingComplete", (event) => {
            traceDataLost ||= event.dataLossOccurred;
            resolve();
          }),
        );
        await cdp.send("Tracing.end");
        await complete;
        const path = info.outputPath(
          `browser-trace-${repeat}-${width}-${partial}.json`,
        );
        await writeFile(path, JSON.stringify({ traceEvents: events }));
        await info.attach(`browser-trace-${repeat}-${width}-${partial}`, {
          path,
          contentType: "application/json",
        });
      }
      console.log(
        `DOM cost repeat ${repeat}: ${width}×${height} ${partial ? "partial" : "full"} complete`,
      );
    }
  await cdp?.detach();
  await info.attach("measurements", {
    body: JSON.stringify(
      {
        browserName,
        browserVersion: browser.version(),
        traceDataLost,
        protocol: {
          repeats: 5,
          warmupFrames: 5,
          measuredFrames: 10,
          cadence: "two requestAnimationFrame boundaries per sample",
          optimized: true,
        },
        results,
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
  expect(
    traceDataLost,
    "Trace buffer overflow invalidates complete pipeline qualification",
  ).toBe(false);
});
