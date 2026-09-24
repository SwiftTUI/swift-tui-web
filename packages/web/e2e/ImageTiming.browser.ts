import { expect, test } from "@playwright/test";
import type {} from "./compiled-wasm.fixture.ts";

for (const renderer of ["dom", "canvas"] as const) {
  test(`compiled AnimatedImage ${renderer} follows live reduced motion, suspension and deterministic capture`, async ({
    page,
  }, info) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/compiled-wasm.html");
    await page.waitForFunction(() => !!window.__compiledWasm);
    await page.evaluate(
      (renderer) =>
        window.__compiledWasm.start("worker", "images", undefined, renderer),
      renderer,
    );
    const frame = () =>
      page.evaluate(() => window.__compiledWasm.snapshot().frames.images);
    await expect
      .poll(async () => (await frame())?.images?.length)
      .toBeGreaterThan(0);
    const first = (await frame())!;
    test.skip(
      first.geometryRevision === undefined,
      "Released legacy producer lacks live host motion style; run the pretag fixture for acceptance",
    );
    const text = () =>
      page.evaluate(() =>
        window.__compiledWasm
          .snapshot()
          .frames.images?.rows.flatMap((row) => row.map((cell) => cell[1]))
          .join(""),
      );
    await expect.poll(text).toContain("Motion reduced");
    const still = first.images![0]!.id;
    await page.waitForTimeout(450);
    expect((await frame())!.images![0]!.id).toBe(still);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect.poll(text).toContain("Motion active");
    await expect
      .poll(async () => (await frame())!.images![0]!.id)
      .not.toBe(still);
    await page.evaluate(() => window.__compiledWasm.suspend(true));
    await page.waitForTimeout(150);
    const paused = await frame();
    const count = await page.evaluate(
      () => window.__compiledWasm.snapshot().frameCounts.images,
    );
    await page.waitForTimeout(450);
    expect(
      await page.evaluate(
        () => window.__compiledWasm.snapshot().frameCounts.images,
      ),
    ).toBe(count);
    expect((await frame())!.images![0]!.id).toBe(paused!.images![0]!.id);
    await page.evaluate(() => window.__compiledWasm.suspend(false));
    await expect
      .poll(
        () =>
          page.evaluate(
            () => window.__compiledWasm.snapshot().frameCounts.images,
          ),
        { timeout: 1000 },
      )
      .toBeGreaterThan(count!);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect.poll(text).toContain("Motion reduced");
    await expect.poll(async () => (await frame())!.images![0]!.id).toBe(still);
    await info.attach("producer-image-timing", {
      body: JSON.stringify({
        renderer,
        still,
        paused: paused?.images?.[0]?.id,
        final: await frame(),
      }),
      contentType: "application/json",
    });
    await page.evaluate(() => window.__compiledWasm.dispose());
  });
}
