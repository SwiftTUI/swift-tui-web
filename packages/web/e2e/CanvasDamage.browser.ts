import { expect, test } from "@playwright/test";
import type {} from "./canvas-damage.fixture.ts";

for (const scale of [1, 2]) {
  test.describe(`Canvas damage at device scale ${scale}`, () => {
    test.use({ deviceScaleFactor: scale });
    for (const overlapping of [false, true]) {
      test(`partial repaint matches full pixels with ${overlapping ? "overlapping" : "one"} translucent image`, async ({ page }) => {
        await page.goto("/health");
        await page.addScriptTag({ url: "/canvas-damage.js", type: "module" });
        await page.waitForFunction(() => typeof window.runCanvasDamageAudit === "function");
        const result = await page.evaluate((overlap) => window.runCanvasDamageAudit(overlap), overlapping);
        expect(result.incremental).toEqual(result.full);
        expect(result.unchangedAfter).toEqual(result.unchangedBefore);
      });
    }
    for (const [label, previous, next] of [
      ["added", " ", "W"],
      ["changed", "W", "I"],
      ["removed", "W", " "],
    ]) {
      test(`italic glyph ${label} stays inside its span and matches a full repaint`, async ({ page }) => {
        await page.goto("/health");
        await page.addScriptTag({ url: "/canvas-damage.js", type: "module" });
        await page.waitForFunction(() => typeof window.runCanvasGlyphDamageAudit === "function");
        const result = await page.evaluate(
          ([before, after]) => window.runCanvasGlyphDamageAudit(before, after),
          [previous, next]
        );
        expect(result.incremental).toEqual(result.full);
        expect(result.outsideSpanInk).toBe(0);
      });
    }
  });
}

test("STUI-320: qualify full-grid clipping cost and oversized-glyph pixel ownership", async ({ page }) => {
  await page.goto("/health");
  await page.addScriptTag({ url: "/canvas-damage.js", type: "module" });
  await page.waitForFunction(() => typeof window.runCanvasClipQualification === "function");
  const result = await page.evaluate(() => window.runCanvasClipQualification());
  expect(result.clips).toBe(9600);
  expect(result.pixelDifferences).toBeGreaterThan(0);
  console.log("CLIP-QUALIFICATION", JSON.stringify(result));
});
