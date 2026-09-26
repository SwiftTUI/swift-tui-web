import { expect, test } from "@playwright/test";
import type {} from "./compiled-wasm.fixture.ts";

// This is a qualification oracle, not a claim that every application reflows.
for (const fontSize of [16, 32]) {
  test(`compiled ordinary prose at 320 CSS px and ${fontSize}px text`, async ({
    page,
  }, info) => {
    await page.goto("/compiled-wasm.html");
    await page.waitForFunction(() => !!window.__compiledWasm);
    await page.evaluate(async (size) => {
      window.__compiledWasm.resizeMount(320, 1200);
      await window.__compiledWasm.start("worker", "reading", undefined, "dom");
      window.__compiledWasm.setFontSize(size);
    }, fontSize);
    const button = page.getByRole("button", {
      name: "Continue reading",
      exact: true,
    });
    await expect(button).toBeAttached();
    await expect
      .poll(() =>
        page.evaluate(
          () => window.__compiledWasm.snapshot().geometry[0]?.fontSize,
        ),
      )
      .toBe(fontSize);
    const before = await page.evaluate(() => {
      const frame = window.__compiledWasm.snapshot().frames.reading!;
      return {
        text: frame.rows
          .map((row) => row.map((cell) => cell[1]).join(""))
          .join(" ")
          .replace(/\s+/g, " "),
        regions: frame.scrollRegions,
        geometry: window.__compiledWasm.snapshot().geometry[0],
      };
    });
    await info.attach("ordinary-prose", {
      contentType: "application/json",
      body: JSON.stringify({
        browser: page.context().browser()?.version(),
        fontSize,
        before,
      }),
    });
    expect(before.text).toContain("Reading");
    // At the larger size the paragraph may need vertical scrolling, but not
    // horizontal scrolling. The control must remain keyboard-operable.
    for (const region of before.regions ?? [])
      expect(region.content[0]).toBeLessThanOrEqual(region.rect[2]);
    const surface = page.locator(".webhost-scene__surface--dom");
    await surface.scrollIntoViewIfNeeded();
    const box = await surface.boundingBox();
    if (!box) throw new Error("Missing reading surface");
    await page.mouse.move(box.x + 50, Math.max(20, box.y + 50));
    for (let i = 0; i < 100; i++) {
      const region = await page.evaluate(
        () =>
          window.__compiledWasm.snapshot().frames.reading?.scrollRegions?.[0],
      );
      if (!region) throw new Error("Missing reading scroll region");
      if (region.offset[1] >= Math.max(0, region.content[1] - region.rect[3]))
        break;
      await page.mouse.wheel(0, 480);
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              window.__compiledWasm.snapshot().frames.reading
                ?.scrollRegions?.[0]?.offset[1],
          ),
        )
        .toBeGreaterThan(region.offset[1]);
    }
    await expect
      .poll(() =>
        page.evaluate(() => {
          const region =
            window.__compiledWasm.snapshot().frames.reading?.scrollRegions?.[0];
          return (
            region &&
            region.offset[1] >= Math.max(0, region.content[1] - region.rect[3])
          );
        }),
      )
      .toBe(true);
    await button.press("Enter");
    await page.mouse.wheel(0, 480);
    await expect(page.locator(".webhost-scene__surface-rows")).toContainText(
      /Continued[\s▐]*1/,
    );
    expect(
      await page.evaluate(
        () => document.getElementById("wasm-mount")!.scrollWidth,
      ),
    ).toBeLessThanOrEqual(320);
    await page.evaluate(() => window.__compiledWasm.dispose());
  });
}
