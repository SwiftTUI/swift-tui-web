import { expect, type Page, test } from "@playwright/test";
import type {
  WebHostAccessibilityActionResponse,
  WebHostAccessibilityNode,
} from "../dist/index.js";

declare global {
  interface Window {
    accessibilityActions: {
      records: string[];
      present(
        nodes: WebHostAccessibilityNode[],
        response?: WebHostAccessibilityActionResponse,
      ): void;
    };
  }
}

const nodes: WebHostAccessibilityNode[] = [
  {
    id: "button",
    actionTarget: "1:button",
    role: "button",
    label: "Increment",
    rect: [0, 0, 10, 1],
    actions: ["focus", "activate"],
  },
  {
    id: "toggle",
    actionTarget: "2:toggle",
    role: "toggle",
    label: "Enabled",
    rect: [0, 1, 10, 1],
    actions: ["focus", "activate", "setValue"],
    value: { type: "boolean", value: false },
  },
  {
    id: "slider",
    actionTarget: "3:slider",
    role: "slider",
    label: "Gain",
    rect: [0, 2, 10, 1],
    actions: ["focus", "increment", "decrement", "setValue"],
    value: { type: "number", value: 2 },
    valueMin: 0,
    valueMax: 10,
    valueStep: 1,
  },
  {
    id: "text",
    actionTarget: "4:text",
    role: "textField",
    label: "Name",
    rect: [0, 3, 10, 1],
    actions: ["focus", "setValue"],
    value: { type: "text", value: "" },
  },
  {
    id: "disabled",
    actionTarget: "5:disabled",
    role: "button",
    label: "Unavailable",
    rect: [0, 4, 10, 1],
    actions: ["focus", "activate"],
    isEnabled: false,
  },
];

async function present(
  page: Page,
  next = nodes,
  response?: WebHostAccessibilityActionResponse,
) {
  await page.evaluate(
    ({ next, response }) => window.accessibilityActions.present(next, response),
    { next, response },
  );
}
async function records(page: Page) {
  return page.evaluate(() => [...window.accessibilityActions.records]);
}

test("assistive controls return typed requests and retain pending edits until acknowledgement", async ({
  page,
}) => {
  await page.goto("/health");
  await page.addScriptTag({ url: "/accessibility-actions.js", type: "module" });
  await page.waitForFunction(() => !!window.accessibilityActions);
  await present(page);
  const button = page.getByRole("button", { name: "Increment" });
  await button.focus();
  await button.press("Enter");
  expect(
    (await records(page)).map((record) => record.split(":").slice(2).join(":")),
  ).toEqual(["1%3Abutton:focus", "1%3Abutton:activate"]);
  await page.getByRole("checkbox", { name: "Enabled" }).press("Space");
  await expect(page.getByRole("checkbox", { name: "Enabled" })).toHaveAttribute(
    "aria-checked",
    "false",
  );
  const slider = page.getByRole("slider", { name: "Gain" });
  await slider.press("ArrowUp");
  await slider.press("ArrowDown");
  await slider.press("End");
  expect(
    (await records(page)).some((record) => record.endsWith(":increment")),
  ).toBe(true);
  expect(
    (await records(page)).some((record) => record.endsWith(":decrement")),
  ).toBe(true);
  expect(
    (await records(page)).some((record) =>
      record.endsWith(":setValue:number:10"),
    ),
  ).toBe(true);

  const text = page.getByRole("textbox", { name: "Name" });
  await text.fill("A");
  const firstEdit = (await records(page)).at(-1)!;
  await text.fill("Ada");
  const lastEdit = (await records(page)).at(-1)!;
  const updated = structuredClone(nodes);
  updated[3]!.value = { type: "text", value: "A" };
  await present(page, updated, {
    requestID: firstEdit.split(":")[1]!,
    target: "4:text",
    result: "accepted",
  });
  await expect(text).toHaveValue("Ada");
  const before = await records(page);
  updated[3]!.value = { type: "text", value: "Ada" };
  await present(page, updated, {
    requestID: lastEdit.split(":")[1]!,
    target: "4:text",
    result: "accepted",
  });
  await expect(text).toHaveValue("Ada");
  expect(await records(page)).toEqual(before);
  await expect(text).toBeFocused();

  await text.fill("rejected");
  const rejected = (await records(page)).at(-1)!;
  await present(page, updated, {
    requestID: rejected.split(":")[1]!,
    target: "4:text",
    result: "invalidValue",
  });
  await expect(text).toHaveValue("Ada");
  const beforeDisabled = await records(page);
  await page
    .getByRole("button", { name: "Unavailable" })
    .dispatchEvent("click");
  expect(await records(page)).toEqual(beforeDisabled);
  await page.evaluate(() => {
    const stale = document.querySelector('[data-accessibility-id="button"]')!;
    window.accessibilityActions.present([]);
    stale.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(await records(page)).toEqual(beforeDisabled);
});
