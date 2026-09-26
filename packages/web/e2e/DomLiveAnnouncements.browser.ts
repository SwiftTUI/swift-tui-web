import { expect, test } from "@playwright/test";
import type {} from "./AccessibilityActions.browser.ts";
import type {} from "./compiled-wasm.fixture.ts";

test("a compiled live update has one native Find match and retains control focus", async ({
  page,
}) => {
  await page.goto("/compiled-wasm.html?renderer=dom");
  await page.getByRole("button", { name: "Start accessibility scene" }).click();
  const activate = page.getByRole("button", { name: "Activate", exact: true });
  for (const count of [1, 2]) {
    await activate.press("Enter");
    const message = `Activated ${count}`;
    await expect(page.locator(".webhost-scene__surface-rows")).toContainText(
      message,
    );
    await expect(activate).toBeFocused();
    const matches = await page.evaluate((message) => {
      const find = (
        window as unknown as {
          find(
            text: string,
            matchCase: boolean,
            backwards: boolean,
            wrap: boolean,
          ): boolean;
        }
      ).find.bind(window);
      const range = document.createRange();
      range.selectNodeContents(document.body);
      range.collapse(true);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      let matches = 0;
      while (matches < 10 && find(message, true, false, false)) matches += 1;
      selection.removeAllRanges();
      return matches;
    }, message);
    expect(matches).toBe(1);
    const announcer = page.locator(".webhost-scene__accessibility-announcer");
    await expect(announcer).toHaveAttribute("aria-live", "polite");
    await expect(announcer).toHaveText("");
    await expect(announcer.getByRole("img")).toHaveAccessibleName(message);
  }
  await page.evaluate(() => window.__compiledWasm.dispose());
});

test("live alternatives preserve Unicode, priority and repeated delivery without replaying idle frames", async ({
  page,
}) => {
  await page.goto("/health?renderer=dom");
  await page.addScriptTag({ url: "/accessibility-actions.js", type: "module" });
  await page.waitForFunction(() => !!window.accessibilityActions);
  const result = await page.evaluate(() => {
    const api = window.accessibilityActions;
    const announcements = [
      { message: "Café 漢字 🙂", politeness: "polite" },
      { message: "Urgent Ångström", politeness: "assertive" },
      { message: "Café 漢字 🙂", politeness: "polite" },
    ];
    const announcer = document.querySelector(
      ".webhost-scene__accessibility-announcer",
    )!;
    api.present([], undefined, announcements);
    const first = announcer.firstElementChild!;
    const firstLabel = first.getAttribute("aria-label");
    const priority = announcer.getAttribute("aria-live");
    api.present([], undefined, announcements);
    const second = announcer.firstElementChild!;
    const secondLabel = second.getAttribute("aria-label");
    api.present([]);
    const unchanged = announcer.firstElementChild === second;
    const text = announcer.textContent;
    api.present([], undefined, [{ message: "", politeness: "polite" }]);
    const emptyChildren = announcer.childElementCount;
    api.present([], undefined, [{ message: " \n ", politeness: "polite" }]);
    const blankChildren = announcer.childElementCount;
    api.dispose();
    return {
      firstLabel,
      secondLabel,
      priority,
      replaced: first !== second,
      unchanged,
      text,
      emptyChildren,
      blankChildren,
    };
  });
  expect(result).toEqual({
    firstLabel: "Urgent Ångström\nCafé 漢字 🙂\nCafé 漢字 🙂",
    secondLabel: "Urgent Ångström\nCafé 漢字 🙂\nCafé 漢字 🙂",
    priority: "assertive",
    replaced: true,
    unchanged: true,
    text: "",
    emptyChildren: 0,
    blankChildren: 0,
  });
});
