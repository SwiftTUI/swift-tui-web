import { expect, test } from "@playwright/test";
import type {} from "./compiled-wasm.fixture.ts";

test("user letter, word and line spacing renegotiate the compiled grid without losing text or input", async ({
  page,
}) => {
  await page.goto("/compiled-wasm.html");
  await page.waitForFunction(() => !!window.__compiledWasm);
  await page.evaluate(async () => {
    window.__compiledWasm.resizeMount(640, 1200);
    await window.__compiledWasm.start("worker", "reading", undefined, "dom");
  });
  const button = page.getByRole("button", {
    name: "Continue reading",
    exact: true,
  });
  await expect(button).toBeAttached();
  const before = await page.evaluate(
    () => window.__compiledWasm.snapshot().geometry[0]!,
  );
  for (const lineHeight of [1.5, 2]) {
    const style = await page.addStyleTag({
      content: `
      .webhost-scene__surface-rows, .webhost-scene__surface-row,
      .webhost-scene__surface-row span, .webhost-scene__surface-row a {
        line-height: ${lineHeight} !important;
        letter-spacing: .12em !important; word-spacing: .16em !important;
      }
    `,
    });
    await expect
      .poll(() =>
        page.evaluate((before) => {
          const state = window.__compiledWasm.snapshot();
          const geometry = state.geometry[0]!;
          return (
            geometry.cellWidth > before.cellWidth &&
            geometry.revision === state.frames.reading?.geometryRevision
          );
        }, before),
      )
      .toBe(true);
    const result = await page.evaluate(() => {
      const state = window.__compiledWasm.snapshot();
      const geometry = state.geometry[0]!;
      const errors: { column: number; error: number }[] = [];
      for (const row of document.querySelectorAll<HTMLElement>(
        ".webhost-scene__surface-row",
      )) {
        const box = row.getBoundingClientRect();
        for (const element of row.querySelectorAll<HTMLElement>(
          "[data-column]",
        )) {
          if (!/^[!-~]$/.test(element.textContent ?? "")) continue;
          const range = document.createRange();
          range.selectNodeContents(element);
          const bounds = range.getBoundingClientRect();
          const column = Number(element.dataset.column);
          const error = Math.abs(
            bounds.left - box.left - column * geometry.cellWidth,
          );
          if (error > 0.5 || bounds.right > box.right + 0.5)
            errors.push({ column, error });
        }
      }
      return {
        geometry,
        errors,
        text: document.querySelector(".webhost-scene__surface-rows")!
          .textContent,
        regions: state.frames.reading!.scrollRegions,
      };
    });
    expect(result.errors).toEqual([]);
    expect(result.geometry.cellHeight).toBeGreaterThanOrEqual(
      result.geometry.fontSize * lineHeight,
    );
    expect(result.text!.replace(/\s+/g, " ")).toContain("reading complete.");
    for (const region of result.regions ?? [])
      expect(region.content[0]).toBeLessThanOrEqual(region.rect[2]);
    const bounds = await button.boundingBox();
    if (!bounds) throw new Error("Missing compiled control geometry");
    // The semantic sidecar deliberately yields pointer input to the painted
    // surface. Exercise its actual hit target rather than clicking the sidecar.
    await page.mouse.click(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
    );
    await expect(page.locator(".webhost-scene__surface-rows")).toContainText(
      lineHeight === 1.5 ? "Continued 1" : "Continued 2",
    );
    await style.evaluate((element) => element.parentNode?.removeChild(element));
    await expect
      .poll(() =>
        page.evaluate(() => {
          const state = window.__compiledWasm.snapshot();
          return [
            state.geometry[0]?.cellWidth,
            state.geometry[0]?.cellHeight,
            state.geometry[0]?.revision ===
              state.frames.reading?.geometryRevision,
          ];
        }),
      )
      .toEqual([before.cellWidth, before.cellHeight, true]);
  }
  await page.evaluate(() => window.__compiledWasm.dispose());
});

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
