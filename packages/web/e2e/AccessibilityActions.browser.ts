import { expect, type Page, test } from "@playwright/test";
import type {
  WebHostAccessibilityActionResponse,
  WebHostAccessibilityNode,
} from "../dist/index.js";

declare global {
  interface Window {
    accessibilityActions: {
      records: string[];
      metrics: { cellWidth: number; cellHeight: number };
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

for (const renderer of ["canvas", "dom"]) {
  test(`${renderer} assistive bounds match scene coordinates through nested and hidden parents`, async ({
    page,
  }) => {
    await page.goto(`/health?renderer=${renderer}`);
    await page.addScriptTag({
      url: "/accessibility-actions.js",
      type: "module",
    });
    await page.waitForFunction(
      () => window.accessibilityActions?.metrics.cellWidth > 0,
    );
    const group: WebHostAccessibilityNode = {
      id: "group",
      parentId: "root",
      role: "group",
      rect: [7, 3, 25, 8],
    };
    const nested: WebHostAccessibilityNode[] = [
      { id: "root", role: "group", rect: [3, 2, 35, 10] },
      group,
      ...nodes.map((node, index) => ({
        ...node,
        parentId: "group",
        isFocused: node.id === "button",
        rect: [9, 4 + index, 10, 1] as [number, number, number, number],
      })),
      {
        id: "editor",
        parentId: "group",
        role: "textEditor",
        label: "Notes",
        actionTarget: "6:editor",
        actions: ["focus", "setValue"],
        rect: [9, 9, 10, 2],
      },
    ];
    const assertBounds = async () => {
      const surface = await page
        .locator(".webhost-scene__surface")
        .boundingBox();
      if (!surface) throw new Error("Missing painted surface bounds");
      const metrics = await page.evaluate(
        () => window.accessibilityActions.metrics,
      );
      for (const node of nested.filter((node) => !node.hidden)) {
        const box = await page
          .locator(`[data-accessibility-id="${node.id}"]`)
          .boundingBox();
        if (!box) throw new Error(`Missing semantic bounds for ${node.id}`);
        expect(box.x, `${node.id} x`).toBeCloseTo(
          surface.x + node.rect[0] * metrics.cellWidth,
          1,
        );
        expect(box.y, `${node.id} y`).toBeCloseTo(
          surface.y + node.rect[1] * metrics.cellHeight,
          1,
        );
        expect(box.width, `${node.id} width`).toBeCloseTo(
          node.rect[2] * metrics.cellWidth,
          1,
        );
        expect(box.height, `${node.id} height`).toBeCloseTo(
          node.rect[3] * metrics.cellHeight,
          1,
        );
      }
    };
    await present(page, nested);
    await assertBounds();
    const tree = page.locator(".webhost-scene__accessibility-tree");
    const terminal = await page
      .locator(".webhost-scene__terminal")
      .boundingBox();
    expect(await tree.boundingBox()).toEqual(terminal);
    await expect(tree).toHaveCSS("clip-path", "none");
    await expect(tree).toHaveCSS("overflow", "visible");
    const button = page.getByRole("button", { name: "Increment" });
    await button.focus();
    await button.press("Enter");
    expect((await records(page)).at(-1)).toContain("1%3Abutton:activate");
    // The invisible semantic overlay must not intercept painted-surface clicks.
    expect(
      await button.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return !!document
          .elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
          ?.closest(".webhost-scene__surface");
      }),
    ).toBe(true);
    // Moving an ancestor must not add its offset to scene-space child bounds.
    group.rect = [5, 1, 25, 8];
    await present(page, nested);
    await assertBounds();
    // A child reparented past a hidden node keeps the same scene-space origin.
    group.hidden = true;
    await present(page, nested);
    await assertBounds();
    await expect(button).toBeFocused();
  });
}
