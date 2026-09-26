import { expect, test } from "@playwright/test";
import type {} from "./compiled-wasm.fixture.ts";

test.use({ trace: "off", screenshot: "off", video: "off" });
test.skip(
  process.env.SWIFTTUI_DOM_QUALIFY !== "1",
  "Opt-in isolated reference-machine qualification",
);
for (let repeat = 0; repeat < 5; repeat++) {
  test(`compiled 120x40 DOM input-to-presentation repeat ${repeat + 1}`, async ({
    page,
    browserName,
  }, info) => {
    test.skip(browserName !== "chromium", "Named Chromium reference lane");
    await page.goto("/compiled-wasm.html");
    await page.waitForFunction(() => !!window.__compiledWasm);
    await page.evaluate(() => {
      window.__compiledWasm.resizeMount(1200, 1100);
      return window.__compiledWasm.start(
        "worker",
        "accessibility",
        undefined,
        "dom",
      );
    });
    const activate = page.getByRole("button", {
      name: "Activate",
      exact: true,
    });
    await expect(activate).toBeAttached();
    await page.waitForFunction(
      () => !!window.__compiledWasm.snapshot().geometry[0]?.sourceRevision,
    );
    await page.evaluate(() => {
      const geometry = window.__compiledWasm.snapshot().geometry[0]!;
      const mount = document
        .getElementById("wasm-mount")!
        .getBoundingClientRect();
      window.__compiledWasm.resizeMount(
        mount.width - geometry.content.width + 120 * geometry.cellWidth,
        mount.height - geometry.content.height + 40 * geometry.cellHeight,
      );
    });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const frame = window.__compiledWasm.snapshot().frames.accessibility;
          return frame && [frame.width, frame.height];
        }),
      )
      .toEqual([120, 40]);
    await activate.focus();
    await page.evaluate(() => window.__compiledWasm.beginControlSample());
    for (let count = 1; count <= 25; count++) {
      await activate.press("Enter");
      await expect
        .poll(() =>
          page.evaluate(() => {
            const samples = window.__compiledWasm.snapshot().controlSamples;
            return [samples.length, samples.at(-1)?.composite !== undefined];
          }),
        )
        .toEqual([count, true]);
      await expect(
        page.getByLabel(`Activated ${count}`, { exact: true }),
      ).toBeAttached();
    }
    const samples = await page.evaluate(() =>
      window.__compiledWasm.snapshot().controlSamples.slice(5),
    );
    const phases = samples.map((sample) => {
      if (
        sample.written === undefined ||
        sample.decoded === undefined ||
        sample.painted === undefined ||
        sample.composite === undefined
      )
        throw new Error("Incomplete timing observation");
      return {
        ingress: sample.written - sample.input,
        producerAndTransport: sample.decoded - sample.written,
        hostPresentation: sample.painted - sample.decoded,
        nextAnimationFrame: sample.composite - sample.painted,
        total: sample.composite - sample.input,
      };
    });
    await info.attach("control-latency", {
      contentType: "application/json",
      body: JSON.stringify({
        repeat,
        browser: page.context().browser()?.version(),
        samples,
        phases,
      }),
    });
    const sorted = phases.map((sample) => sample.total).sort((a, b) => a - b);
    expect(sorted[Math.ceil(sorted.length * 0.95) - 1]).toBeLessThanOrEqual(
      100,
    );
    expect(sorted.at(-1)).toBeLessThanOrEqual(250);
    expect(
      await page.evaluate(() => window.__compiledWasm.snapshot().errors),
    ).toEqual([]);
    await page.evaluate(() => window.__compiledWasm.dispose());
  });
}
