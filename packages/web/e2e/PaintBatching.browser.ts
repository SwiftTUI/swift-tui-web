import { expect, test } from "@playwright/test";
import type { PaintBurstOptions } from "./paint-batching.fixture.ts";

const BURST_FRAMES = 120;

async function loadFixture(
  page: import("@playwright/test").Page,
): Promise<void> {
  await page.goto("/health");
  await page.addScriptTag({ url: "/paint-batching.js", type: "module" });
  await page.waitForFunction(() => typeof window.runPaintBurst === "function");
}

for (const [label, shape] of [
  ["one-cell deltas on a 20x6 grid", { damage: "cell", width: 20, height: 6 }],
  ["full repaints of an 80x24 grid", { damage: "full", width: 80, height: 24 }],
] as const satisfies ReadonlyArray<
  readonly [string, Omit<PaintBurstOptions, "frameCount" | "scheduling">]
>) {
  test(`STUI-143: a burst of ${label} paints once per animation frame and matches painting every frame`, async ({
    page,
  }) => {
    await loadFixture(page);
    const batched = await page.evaluate(
      (options) => window.runPaintBurst(options),
      {
        ...shape,
        frameCount: BURST_FRAMES,
        scheduling: "default",
      } satisfies PaintBurstOptions,
    );
    const synchronous = await page.evaluate(
      (options) => window.runPaintBurst(options),
      {
        ...shape,
        frameCount: BURST_FRAMES,
        scheduling: "synchronous",
      } satisfies PaintBurstOptions,
    );

    // Every frame in the burst was presented; batching painted the burst
    // once, the pre-batching runtime once per frame.
    expect(batched.presentedFrames).toBe(BURST_FRAMES - 1);
    expect(synchronous.presentedFrames).toBe(BURST_FRAMES - 1);
    expect(batched.paints).toBe(1);
    expect(batched.coalescedFrames).toBe(BURST_FRAMES - 2);
    expect(synchronous.paints).toBe(BURST_FRAMES - 1);
    expect(synchronous.coalescedFrames).toBe(0);

    // The single (unioned or full) paint shows exactly what painting every
    // frame shows, and the burst touched enough pixels for a missed row to show.
    expect(batched.changedPixels).toBeGreaterThan(1_000);
    expect(batched.pixels).toEqual(synchronous.pixels);

    console.log(
      "PAINT-BATCHING",
      JSON.stringify({
        shape: label,
        frames: BURST_FRAMES,
        batched: {
          paints: batched.paints,
          coalescedFrames: batched.coalescedFrames,
          ingestMs: round(batched.ingestMs),
          paintMs: round(batched.paintMs),
          mainThreadMs: round(batched.ingestMs + batched.paintMs),
        },
        synchronous: {
          paints: synchronous.paints,
          mainThreadMs: round(synchronous.ingestMs),
        },
      }),
    );
  });
}

test("STUI-143: clicks during a pending paint resolve against the newest frame", async ({
  page,
}) => {
  await loadFixture(page);
  // A genuine mouse move tells the fixture this engine's mouse pointer id, so
  // the in-task synthetic clicks name an active pointer the runtime can capture.
  await page.mouse.move(20, 20);
  const result = await page.evaluate(() => window.runPaintInputJourney());
  expect(result.stalePixelsAtClick).toBe(true);
  expect(result.openedBeforePaint).toEqual(["https://example.test/row-1"]);
  expect(result.freshPixelsAfterPaint).toBe(true);
});

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
