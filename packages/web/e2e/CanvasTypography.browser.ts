import { expect, test } from "@playwright/test";
import type {} from "./AccessibilityActions.browser.ts";

test("Canvas remeasures user text enlargement and spacing without losing review focus", async ({
  page,
}) => {
  await page.goto("/health?renderer=canvas");
  await page.addScriptTag({ url: "/accessibility-actions.js", type: "module" });
  await page.waitForFunction(() => !!window.accessibilityActions);
  await page.evaluate(() =>
    window.accessibilityActions.present([
      {
        id: "action",
        actionTarget: "action",
        role: "button",
        label: "Action",
        rect: [1, 1, 6, 1],
        actions: ["activate"],
      },
    ]),
  );
  const action = page.getByRole("button", { name: "Action", exact: true });
  await action.focus();
  const original = await page.evaluate(
    () => window.accessibilityActions.geometry,
  );
  expect(original).toBeDefined();
  await page.addStyleTag({
    content: `canvas.webhost-scene__surface {
    font-size: 32px !important; line-height: 1.5 !important;
    letter-spacing: .12em !important; word-spacing: .16em !important;
  }`,
  });
  await expect
    .poll(() =>
      page.evaluate(() => window.accessibilityActions.geometry?.fontSize),
    )
    .toBe(32);
  const enlarged = await page.evaluate(
    () => window.accessibilityActions.geometry,
  );
  expect(enlarged!.cellHeight).toBeGreaterThanOrEqual(48);
  expect(enlarged!.cellWidth).toBeGreaterThan(original!.cellWidth);
  expect(enlarged!.revision).toBeGreaterThan(original!.revision);
  // This fixture keeps a fixed 40-column producer frame. Inspect the host's
  // resize request to prove the next producer layout has fewer columns.
  const requestedColumns = await page.evaluate(() => {
    const resize = window.accessibilityActions.inputRecords
      .filter((record) => record.startsWith("\u001eresize:"))
      .at(-1);
    return Number(resize?.split(":")[1]);
  });
  expect(requestedColumns).toBeLessThan(original!.columns);
  await expect(action).toBeFocused();
  const alignment = await page.evaluate(() => {
    const ring = document
      .querySelector(".webhost-scene__focus-ring")!
      .getBoundingClientRect();
    const control = document
      .querySelector('[data-accessibility-id="action"]')!
      .getBoundingClientRect();
    return [
      Math.abs(ring.x - control.x),
      Math.abs(ring.y - control.y),
      Math.abs(ring.width - control.width),
      Math.abs(ring.height - control.height),
    ];
  });
  for (const delta of alignment) expect(delta).toBeLessThanOrEqual(0.5);
  await action.press("Enter");
  const activated = await page.evaluate(
    () =>
      window.accessibilityActions.records.filter((record) =>
        record.includes(":activate"),
      ).length,
  );
  expect(activated).toBe(1);
});
