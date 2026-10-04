import { expect, test } from "@playwright/test";
import type {} from "./AccessibilityActions.browser.ts";

for (const renderer of ["canvas", "dom"]) {
  test(`${renderer}: visible two-tone focus follows browser review without waiting for keyboard focus`, async ({
    page,
  }) => {
    await page.goto(`/health?renderer=${renderer}`);
    await page.addScriptTag({
      url: "/accessibility-actions.js",
      type: "module",
    });
    await page.waitForFunction(() => !!window.accessibilityActions);
    await page.evaluate(() =>
      window.accessibilityActions.present([
        {
          id: "keyboard",
          actionTarget: "keyboard",
          role: "textField",
          label: "Keyboard owner",
          rect: [1, 1, 10, 1],
          isFocused: true,
          cursorAnchor: [3, 1],
          actions: ["focus", "setValue"],
          value: { type: "text", value: "abc" },
        },
        {
          id: "review",
          actionTarget: "review",
          role: "button",
          label: "Review target",
          rect: [2, 4, 12, 2],
          isFocused: false,
          actions: ["activate"],
        },
      ]),
    );
    await page.getByRole("button", { name: "Review target" }).focus();
    await expect(page.locator(".webhost-scene__focus-layer")).toBeVisible();
    await expect(page.locator(".webhost-scene__caret")).toBeHidden();
    const result = await page.evaluate(() => {
      const ring = document.querySelector<HTMLElement>(
        ".webhost-scene__focus-ring",
      )!;
      const review = document.querySelector<HTMLElement>(
        '[data-accessibility-id="review"]',
      )!;
      const box = (element: HTMLElement) => {
        const r = element.getBoundingClientRect();
        return [r.x, r.y, r.width, r.height];
      };
      return {
        ring: box(ring),
        target: box(review),
        outline: ring.style.outlineColor,
        shadow: ring.style.boxShadow,
        keyboardStillOwned: document
          .querySelector('[data-accessibility-id="keyboard"]')
          ?.getAttribute("data-focused"),
        records: window.accessibilityActions.records,
      };
    });
    result.ring.forEach((value, i) => {
      expect(Math.abs(value - result.target[i]!)).toBeLessThanOrEqual(0.5);
    });
    expect(result.outline).toBe("rgb(255, 255, 255)");
    expect(result.shadow).toContain("rgb(0, 0, 0)");
    expect(result.keyboardStillOwned).toBe("true");
    expect(result.records.some((value) => value.includes(":activate"))).toBe(
      false,
    );
    await page.getByRole("textbox", { name: "Keyboard owner" }).focus();
    await expect(page.locator(".webhost-scene__caret")).toBeVisible();
  });
}

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
  await page.locator(".webhost-scene__header").evaluate((e) => {
    (e as HTMLElement).tabIndex = 0;
    (e as HTMLElement).focus();
  });
  await expect(page.locator(".webhost-scene__focus-layer")).toBeHidden();
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

test("native fields retain keyboard selection and replacement without a selection mode", async ({
  page,
}) => {
  await page.goto("/health?renderer=dom");
  await page.addScriptTag({ url: "/accessibility-actions.js", type: "module" });
  await page.waitForFunction(() => !!window.accessibilityActions);
  await page.evaluate(() =>
    window.accessibilityActions.present([
      {
        id: "field",
        actionTarget: "field:1",
        role: "textField",
        label: "Field",
        rect: [0, 0, 10, 1],
        actions: ["focus", "setValue"],
        value: { type: "text", value: "hello" },
      },
      {
        id: "editor",
        actionTarget: "editor:1",
        role: "textEditor",
        label: "Editor",
        rect: [0, 2, 10, 2],
        actions: ["focus", "setValue"],
        value: { type: "text", value: "two\nlines" },
      },
    ]),
  );
  for (const name of ["Field", "Editor"]) {
    const field = page.getByRole("textbox", { name, exact: true });
    await field.focus();
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+a" : "Control+a",
    );
    expect(
      await field.evaluate((e) => {
        const input = e as HTMLInputElement | HTMLTextAreaElement;
        return input.value.slice(
          input.selectionStart ?? 0,
          input.selectionEnd ?? 0,
        );
      }),
    ).toBe(name === "Field" ? "hello" : "two\nlines");
    await page.keyboard.type("replacement");
    await expect(field).toHaveValue("replacement");
  }
  expect(
    await page.evaluate(() =>
      window.accessibilityActions.records.some((s) =>
        s.includes("replacement"),
      ),
    ),
  ).toBe(true);
});
