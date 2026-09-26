import { expect, test } from "@playwright/test";
import type {} from "./AccessibilityActions.browser.ts";

test("caret and visible focus share semantic geometry across zoom without moving browser focus", async ({
  page,
}) => {
  await page.goto("/health?renderer=dom");
  await page.addScriptTag({ url: "/accessibility-actions.js", type: "module" });
  await page.waitForFunction(() => !!window.accessibilityActions);
  await page.evaluate(() =>
    window.accessibilityActions.present([
      {
        id: "editor",
        actionTarget: "editor:1",
        role: "textField",
        label: "Editor",
        rect: [3, 2, 7, 1],
        cursorAnchor: [6, 2],
        isFocused: true,
        actions: ["focus", "setValue"],
        value: { type: "text", value: "abc" },
      },
    ]),
  );
  const editor = page.getByRole("textbox", { name: "Editor" });
  await expect(editor).toBeFocused();
  const before = await page.evaluate(
    () => window.accessibilityActions.records.length,
  );
  for (const zoom of [0.8, 1, 1.25, 2]) {
    await page.evaluate((zoom) => {
      const scene = document.querySelector<HTMLElement>(".webhost-scene")!;
      scene.parentElement!.style.zoom = String(zoom);
      scene.parentElement!.style.transform = "scale(1.1, 1.2)";
      scene.parentElement!.style.transformOrigin = "0 0";
      window.dispatchEvent(new Event("resize"));
    }, zoom);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const state = await page.evaluate(() => {
      const g = window.accessibilityActions.geometry!;
      const box = (selector: string) => {
        const r = document.querySelector(selector)!.getBoundingClientRect();
        return {
          x: (r.x - g.content.left) / g.content.scaleX,
          y: (r.y - g.content.top) / g.content.scaleY,
          width: r.width / g.content.scaleX,
          height: r.height / g.content.scaleY,
        };
      };
      return {
        g,
        ring: box(".webhost-scene__focus-ring"),
        caret: box(".webhost-scene__caret"),
        semantic: box('[data-accessibility-id="editor"]'),
      };
    });
    for (const key of ["x", "y", "width", "height"] as const)
      expect(
        Math.abs(state.ring[key] - state.semantic[key]),
      ).toBeLessThanOrEqual(0.5);
    expect(Math.abs(state.caret.x - 6 * state.g.cellWidth)).toBeLessThanOrEqual(
      0.5,
    );
    expect(
      Math.abs(state.caret.y - 2 * state.g.cellHeight),
    ).toBeLessThanOrEqual(0.5);
    expect(
      Math.abs(state.caret.height - state.g.cellHeight),
    ).toBeLessThanOrEqual(0.5);
    await expect(editor).toBeFocused();
  }
  expect(
    await page.evaluate(() => window.accessibilityActions.records.length),
  ).toBe(before);
  await page.getByRole("button", { name: "Select text", exact: true }).click();
  await expect(page.locator(".webhost-scene__focus-layer")).toBeHidden();
  await page.keyboard.press("Escape");
  await editor.focus();
  await expect(page.locator(".webhost-scene__focus-layer")).toBeVisible();
  await page.emulateMedia({ forcedColors: "active" });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  if (
    await page.evaluate(() => matchMedia("(forced-colors: active)").matches)
  ) {
    expect(
      await page
        .locator(".webhost-scene__focus-ring")
        .evaluate((e) => (e as HTMLElement).style.outlineColor),
    ).toBe("canvastext");
    if (await page.evaluate(() => CSS.supports("forced-color-adjust", "none")))
      expect(
        await page
          .locator(".webhost-scene__caret")
          .evaluate((e) => getComputedStyle(e).forcedColorAdjust),
      ).toBe("none");
  }
});
