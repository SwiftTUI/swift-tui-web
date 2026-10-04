import { expect, test } from "@playwright/test";
import type { WebHostAccessibilityNode } from "../dist/index.js";
import type {} from "./AccessibilityActions.browser.ts";

// Fixtures contain public sample text; secure-field checks retain no payloads.
test.use({ trace: "off", screenshot: "off", video: "off" });
const editor: WebHostAccessibilityNode = {
  id: "editor",
  actionTarget: "editor:1",
  role: "textEditor",
  label: "Notes",
  rect: [0, 0, 30, 4],
  actions: ["focus", "setValue", "editText", "selectText"],
  value: { type: "text", value: "alpha mistake\nsecond line" },
  textSelection: [0, 0],
};
for (const renderer of ["canvas", "dom"] as const) {
  test.describe(renderer, () => {
    test.beforeEach(async ({ page }) => {
      await page.goto(`/health?renderer=${renderer}`);
      await page.addScriptTag({
        url: "/accessibility-actions.js",
        type: "module",
      });
      await page.waitForFunction(() => !!window.accessibilityActions);
      await page.evaluate(
        (node) => window.accessibilityActions.present([node]),
        editor,
      );
    });

    test("composition survives incoming frames and commits text and caret once", async ({
      page,
    }) => {
      const input = page.getByRole("textbox", { name: "Notes" });
      await input.focus();
      const result = await input.evaluate((element, model) => {
        const input = element as HTMLTextAreaElement;
        const api = window.accessibilityActions;
        api.records.length = 0;
        input.dispatchEvent(
          new CompositionEvent("compositionstart", { bubbles: true }),
        );
        input.value = "café";
        input.setSelectionRange(4, 4);
        input.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            isComposing: true,
            inputType: "insertCompositionText",
          }),
        );
        api.present([model]);
        const during = {
          value: input.value,
          head: input.selectionEnd,
          requests: api.records.length,
        };
        input.dispatchEvent(
          new CompositionEvent("compositionend", { bubbles: true, data: "é" }),
        );
        input.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            inputType: "insertFromComposition",
          }),
        );
        api.present([model]);
        return { during, after: input.value, requests: [...api.records] };
      }, editor);
      expect(result.during).toEqual({ value: "café", head: 4, requests: 0 });
      expect(result.after).toBe("café");
      expect(result.requests).toHaveLength(1);
      expect(result.requests[0]).toContain(":editText:text:caf%C3%A9:4:4");
      await page.evaluate(
        ({ model, request }) =>
          window.accessibilityActions.present(
            [
              {
                ...model,
                value: { type: "text", value: "café" },
                textSelection: [4, 4],
              },
            ],
            {
              requestID: request.split(":")[1]!,
              target: model.actionTarget!,
              result: "accepted",
            },
          ),
        { model: editor, request: result.requests[0]! },
      );
      await expect(input).toHaveValue("café");
      await input.evaluate((element) =>
        (element as HTMLTextAreaElement).setSelectionRange(1, 4, "backward"),
      );
      await expect
        .poll(() =>
          page.evaluate(() =>
            window.accessibilityActions.records
              .filter((record) => record.includes(":selectText:"))
              .at(-1),
          ),
        )
        .toContain(":selectText:text:caf%C3%A9:4:1");
    });

    test("middle correction and native undo preserve selection through acknowledgements", async ({
      page,
    }) => {
      const input = page.getByRole("textbox", { name: "Notes" });
      await input.focus();
      await input.evaluate((element) =>
        (element as HTMLTextAreaElement).setSelectionRange(6, 13),
      );
      await expect
        .poll(() =>
          page.evaluate(() =>
            window.accessibilityActions.records.some((record) =>
              record.includes(
                ":selectText:text:alpha%20mistake%0Asecond%20line:6:13",
              ),
            ),
          ),
        )
        .toBe(true);
      await input.pressSequentially("fixed");
      await expect(input).toHaveValue("alpha fixed\nsecond line");
      const selection = await input.evaluate((element) => ({
        start: (element as HTMLTextAreaElement).selectionStart,
        end: (element as HTMLTextAreaElement).selectionEnd,
      }));
      expect(selection).toEqual({ start: 11, end: 11 });
      await page.evaluate((model) => {
        const api = window.accessibilityActions;
        const request = api.records
          .filter((record) => record.includes(":editText:"))
          .at(-1)!;
        api.present(
          [
            {
              ...model,
              value: { type: "text", value: "alpha fixed\nsecond line" },
              textSelection: [11, 11],
            },
          ],
          {
            requestID: request.split(":")[1]!,
            target: model.actionTarget!,
            result: "accepted",
          },
        );
      }, editor);
      await expect(input).toBeFocused();
      await input.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
      await expect(input).toHaveValue("alpha mistake\nsecond line");
      await expect
        .poll(() =>
          page.evaluate(() =>
            window.accessibilityActions.records
              .filter((record) => record.includes(":editText:"))
              .at(-1),
          ),
        )
        .toContain(":editText:text:alpha%20mistake%0Asecond%20line:");
    });

    test("authoritative selection preserves direction and retired composition cannot edit a replacement", async ({
      page,
    }) => {
      const input = page.getByRole("textbox", { name: "Notes" });
      await input.focus();
      await page.evaluate(
        (model) =>
          window.accessibilityActions.present([
            { ...model, textSelection: [13, 6] },
          ]),
        editor,
      );
      expect(
        await input.evaluate((element) => {
          const input = element as HTMLTextAreaElement;
          return [
            input.selectionStart,
            input.selectionEnd,
            input.selectionDirection,
          ];
        }),
      ).toEqual([6, 13, "backward"]);
      const counts = await input.evaluate((element, model) => {
        const api = window.accessibilityActions;
        element.dispatchEvent(
          new CompositionEvent("compositionstart", { bubbles: true }),
        );
        (element as HTMLTextAreaElement).value = "intermediate";
        api.present([{ ...model, actionTarget: "editor:2" }]);
        const before = api.records.length;
        element.dispatchEvent(
          new CompositionEvent("compositionend", { bubbles: true }),
        );
        element.dispatchEvent(new InputEvent("input", { bubbles: true }));
        return [
          before,
          api.records.length,
          (element as HTMLTextAreaElement).value,
        ];
      }, editor);
      expect(counts[1]).toBe(counts[0]);
      expect(counts[2]).toBe("");
    });

    test("heading and paragraph text remain selectable across unchanged frames", async ({
      page,
    }) => {
      const result = await page.evaluate(() => {
        const api = window.accessibilityActions;
        const nodes: WebHostAccessibilityNode[] = [
          {
            id: "heading",
            role: "heading(level: 2)",
            label: "Résumé",
            rect: [0, 0, 20, 1],
            properties: { language: "fr" },
          },
          {
            id: "ordinary",
            role: "group",
            label: "Ordinary source text.",
            rect: [0, 3, 30, 1],
            properties: { textKind: "plain" },
          },
          {
            id: "prose",
            role: "group",
            label: "Bonjour le monde.",
            rect: [0, 1, 30, 2],
            properties: { textKind: "paragraph", language: "fr" },
          },
        ];
        api.present(nodes);
        const heading = document.querySelector(
          '[data-accessibility-id="heading"]',
        )!;
        const text = heading.firstChild!;
        const range = document.createRange();
        range.setStart(text, 0);
        range.setEnd(text, 6);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        api.present(nodes);
        return {
          selected: selection.toString(),
          textRetained: heading.firstChild === text,
          labels: heading.getAttribute("aria-label"),
          language: heading.getAttribute("lang"),
        };
      });
      expect(result).toEqual({
        selected: "Résumé",
        textRetained: true,
        labels: null,
        language: "fr",
      });
      await expect(
        page.getByRole("heading", { name: "Résumé", level: 2 }),
      ).toHaveCount(1);
      await expect(page.getByRole("paragraph")).toHaveText("Bonjour le monde.");
      const ordinary = page.locator('[data-accessibility-id="ordinary"]');
      await expect(ordinary).toHaveText("Ordinary source text.");
      await expect(ordinary).not.toHaveAttribute("aria-label");
    });
  });
}
