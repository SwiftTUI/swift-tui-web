import { expect, type Page, test } from "@playwright/test";
import type {} from "./AccessibilityActions.browser.ts";

// Never retain screenshots, DOM snapshots or wire payloads containing edits.
test.use({ trace: "off", screenshot: "off", video: "off" });

async function load(page: Page) {
  await page.goto("/health?renderer=dom");
  await page.addScriptTag({ url: "/accessibility-actions.js", type: "module" });
  await page.waitForFunction(() => !!window.accessibilityActions);
}

test("native editable composition sends only the final committed value, once", async ({
  page,
}) => {
  await load(page);
  const state = await page.evaluate(() => {
    const api = window.accessibilityActions;
    api.present([
      {
        id: "edit",
        actionTarget: "edit:1",
        role: "textField",
        label: "Name",
        rect: [0, 0, 10, 1],
        actions: ["focus", "setValue"],
        value: { type: "text", value: "" },
      },
    ]);
    const input = document.querySelector<HTMLInputElement>(
      '[data-accessibility-id="edit"]',
    )!;
    input.focus();
    api.records.length = 0;
    input.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    input.value = "e";
    input.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        isComposing: true,
        inputType: "insertCompositionText",
      }),
    );
    const intermediate = api.records.length;
    input.value = "é";
    input.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true, data: "é" }),
    );
    input.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        inputType: "insertFromComposition",
      }),
    );
    const committed = [...api.records];
    input.value = "é!";
    input.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText" }),
    );
    return { intermediate, committed, all: [...api.records] };
  });
  expect(state.intermediate).toBe(0);
  expect(state.committed).toHaveLength(1);
  expect(state.committed[0]).toContain(":setValue:text:%C3%A9");
  expect(state.all).toHaveLength(2);
  expect(state.all[1]).toContain(":setValue:text:%C3%A9!");
});

test("separate embeds own unique semantic IDs, actions, focus and disposal", async ({
  page,
}) => {
  await load(page);
  const state = await page.evaluate(async () => {
    const first = window.accessibilityActions;
    const path = "/accessibility-actions.js?second";
    await import(path);
    const second = window.accessibilityActions;
    const node = {
      id: "same",
      actionTarget: "same:1",
      role: "button" as const,
      label: "Action",
      rect: [0, 0, 10, 1] as [number, number, number, number],
      actions: ["focus", "activate"] as ("focus" | "activate")[],
    };
    first.present([node]);
    second.present([node]);
    const controls = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-accessibility-id="same"]',
      ),
    ];
    const ids = controls.map((e) => e.id);
    controls[0]!.click();
    controls[1]!.click();
    const actions = [first.records.length, second.records.length];
    first.dispose();
    controls[0]!.click();
    controls[1]!.click();
    controls[1]!.focus();
    const remaining = document.querySelectorAll(
      '[data-accessibility-id="same"]',
    ).length;
    const focused = document.activeElement === controls[1];
    const after = [first.records.length, second.records.length];
    second.dispose();
    controls[1]!.click();
    return {
      ids,
      actions,
      after,
      remaining,
      focused,
      late: second.records.length,
      layers: document.querySelectorAll(
        ".webhost-scene__focus-layer,.webhost-scene__selection-controls",
      ).length,
    };
  });
  expect(new Set(state.ids).size).toBe(2);
  expect(state.actions).toEqual([1, 1]);
  expect(state.after).toEqual([1, 3]);
  expect(state.remaining).toBe(1);
  expect(state.focused).toBe(true);
  expect(state.late).toBe(3);
  expect(state.layers).toBe(0);
});

test.describe("secure proxy lifetime", () => {
  for (const ending of ["blur", "remove", "replace", "dispose"] as const) {
    test(`secure input clears on ${ending} and never appears in serialized DOM`, async ({
      page,
    }) => {
      await load(page);
      const result = await page.evaluate((ending) => {
        const api = window.accessibilityActions;
        const node = {
          id: "secret",
          actionTarget: "secret:1",
          role: "secureField" as const,
          label: "Password",
          rect: [0, 0, 10, 1] as [number, number, number, number],
          actions: ["focus", "setValue"] as ("focus" | "setValue")[],
        };
        api.present([node]);
        const input = document.querySelector<HTMLInputElement>(
          '[data-accessibility-id="secret"]',
        )!;
        input.focus();
        api.records.length = 0;
        const privateValue = crypto.randomUUID();
        input.value = privateValue;
        input.dispatchEvent(
          new InputEvent("input", { bubbles: true, inputType: "insertText" }),
        );
        const once = api.records.length === 1;
        const payloadCorrect = api.records[0]?.endsWith(
          encodeURIComponent(privateValue),
        );
        const serializedClean =
          !document.documentElement.outerHTML.includes(privateValue);
        api.records.length = 0;
        if (ending === "blur") input.blur();
        if (ending === "remove") api.present([]);
        if (ending === "replace")
          api.present([{ ...node, actionTarget: "secret:2" }]);
        if (ending === "dispose") api.dispose();
        const cleared = input.value === "";
        if (ending !== "blur") {
          input.dispatchEvent(new InputEvent("input", { bubbles: true }));
          input.dispatchEvent(
            new CompositionEvent("compositionend", { bubbles: true }),
          );
        }
        const late = api.records.length;
        api.records.length = 0;
        return { once, payloadCorrect, serializedClean, cleared, late };
      }, ending);
      expect(result).toEqual({
        once: true,
        payloadCorrect: true,
        serializedClean: true,
        cleared: true,
        late: 0,
      });
    });
  }
});
