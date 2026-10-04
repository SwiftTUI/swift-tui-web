import { expect, type Page, test } from "@playwright/test";
import type {
  WebHostAccessibilityActionResponse,
  WebHostAccessibilityAnnouncement,
  WebHostAccessibilityNode,
} from "../dist/index.js";

declare global {
  interface Window {
    accessibilityActions: {
      records: string[];
      inputRecords: string[];
      geometry: import("../dist/index.js").WebHostSceneRuntime["geometrySnapshot"];
      dispose(): void;
      metrics: { cellWidth: number; cellHeight: number };
      present(
        nodes: WebHostAccessibilityNode[],
        response?: WebHostAccessibilityActionResponse,
        announcements?: WebHostAccessibilityAnnouncement[],
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

test("unchanged frames preserve navigation past a field and reconcile rejected focus once", async ({
  page,
}) => {
  await page.goto("/health");
  await page.addScriptTag({ url: "/accessibility-actions.js", type: "module" });
  await page.waitForFunction(() => !!window.accessibilityActions);
  const snapshot = structuredClone(nodes);
  snapshot.push({
    id: "password",
    actionTarget: "6:password",
    role: "secureField",
    label: "Password",
    rect: [0, 5, 10, 1],
    actions: ["focus", "setValue"],
    isFocused: true,
  });
  await present(page, snapshot);
  const password = page.getByLabel("Password", { exact: true });
  await expect(password).toHaveAttribute("type", "password");
  await expect(password).not.toHaveAttribute("role");
  const disabled = page.getByRole("button", { name: "Unavailable" });
  await expect(password).toBeFocused();
  await disabled.focus();
  await present(page, snapshot);
  await expect(disabled).toBeFocused();
  await page.evaluate(() => {
    const outside = document.createElement("button");
    outside.textContent = "Outside scene";
    document.body.appendChild(outside);
    outside.focus();
  });
  await present(page, snapshot);
  await expect(
    page.getByRole("button", { name: "Outside scene" }),
  ).toBeFocused();

  // A real runtime focus transition still reaches the browser.
  snapshot.at(-1)!.isFocused = false;
  snapshot[3]!.isFocused = true;
  await present(page, snapshot);
  const name = page.getByRole("textbox", { name: "Name" });
  await expect(name).toBeFocused();
  const button = page.getByRole("button", { name: "Increment" });
  await button.focus();
  const requestID = (await records(page)).at(-1)!.split(":")[1]!;
  await present(page, snapshot);
  await expect(button).toBeFocused();
  const rejected = {
    requestID,
    target: "1:button",
    result: "outOfScope" as const,
  };
  await present(page, snapshot, rejected);
  await expect(name).toBeFocused();
  await disabled.focus();
  await present(page, snapshot, rejected);
  await expect(disabled).toBeFocused();

  // A late acknowledgement must not undo navigation that sent no focus action.
  await button.focus();
  const lateID = (await records(page)).at(-1)!.split(":")[1]!;
  await disabled.focus();
  snapshot[3]!.isFocused = false;
  snapshot[0]!.isFocused = true;
  await present(page, snapshot, {
    requestID: lateID,
    target: "1:button",
    result: "accepted",
  });
  await expect(disabled).toBeFocused();
  await present(page, snapshot);
  await expect(disabled).toBeFocused();
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
    const projection = await page
      .locator(
        renderer === "dom"
          ? ".webhost-scene__surface"
          : ".webhost-scene__terminal",
      )
      .boundingBox();
    expect(await tree.boundingBox()).toEqual(projection);
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

for (const renderer of ["canvas", "dom"]) {
  test(`${renderer} widget properties update in place and resolve only current scene relationships`, async ({
    page,
  }) => {
    await page.goto(`/health?renderer=${renderer}`);
    await page.addScriptTag({
      url: "/accessibility-actions.js",
      type: "module",
    });
    await page.waitForFunction(() => !!window.accessibilityActions);
    const related: WebHostAccessibilityNode[] = [
      {
        id: "label/é",
        role: "group",
        label: "Authored name",
        rect: [0, 1, 20, 1],
      },
      // These IDs collided in the former DOM ID encoding.
      {
        id: "label-2f-é",
        role: "group",
        label: "Other name",
        rect: [0, 2, 20, 1],
      },
      {
        id: "help",
        role: "group",
        label: "Helpful description",
        rect: [0, 3, 20, 1],
      },
      {
        id: "error",
        role: "group",
        label: "Correct this",
        rect: [0, 4, 20, 1],
      },
      {
        id: "hidden",
        role: "group",
        label: "Private",
        hidden: true,
        rect: [0, 5, 20, 1],
      },
    ];
    const field: WebHostAccessibilityNode = {
      ...nodes[3]!,
      properties: {
        selected: false,
        expanded: true,
        required: true,
        invalid: true,
        busy: true,
        readOnly: true,
        description: "Detailed help",
        language: "fr",
        positionInSet: 2,
        setSize: 5,
        labelledBy: ["label/é"],
        describedBy: ["help", "missing", "hidden", "text", "help"],
        errorMessage: ["error"],
        controls: ["help"],
        flowTo: ["error"],
        activeDescendant: "help",
      },
    };
    await present(page, [field, ...related]);
    const input = page.locator('[data-accessibility-id="text"]');
    await expect(input).toHaveAccessibleName("Authored name");
    await expect(input).toHaveAttribute("aria-selected", "false");
    await expect(input).toHaveAttribute("aria-expanded", "true");
    await expect(input).toHaveAttribute("aria-required", "true");
    await expect(input).toHaveAttribute("aria-invalid", "true");
    await expect(input).toHaveAttribute("aria-busy", "true");
    await expect(input).toHaveAttribute("aria-readonly", "true");
    await expect(input).toHaveAttribute("lang", "fr");
    await expect(input).toHaveAttribute("aria-posinset", "2");
    await expect(input).toHaveAttribute("aria-setsize", "5");
    const helpID = await page
      .locator('[data-accessibility-id="help"]')
      .getAttribute("id");
    await expect(input).toHaveAttribute("aria-describedby", helpID!);
    const ids = await page
      .locator("[data-accessibility-id]")
      .evaluateAll((elements) => elements.map((e) => e.id));
    expect(new Set(ids).size).toBe(ids.length);
    await input.focus();
    const url = page.url();
    await input.press("Backspace");
    expect(page.url()).toBe(url);
    await input.evaluate((element) => {
      (element as HTMLInputElement).value = "rejected";
      element.dispatchEvent(new Event("input", { bubbles: true }));
      (element as HTMLElement).dataset.retained = "yes";
    });
    expect((await records(page)).filter((r) => r.includes("setValue"))).toEqual(
      [],
    );
    await present(page, [{ ...field, properties: undefined }, ...related]);
    await expect(input).toHaveAttribute("data-retained", "yes");
    await expect(input).toHaveAccessibleName("Name");
    for (const name of [
      "aria-selected",
      "aria-expanded",
      "aria-required",
      "aria-invalid",
      "aria-busy",
      "aria-readonly",
      "lang",
      "aria-posinset",
      "aria-setsize",
      "aria-labelledby",
      "aria-describedby",
      "aria-errormessage",
      "aria-controls",
      "aria-flowto",
      "aria-activedescendant",
    ]) {
      expect(await input.getAttribute(name)).toBeNull();
    }
    expect(await input.evaluate((e) => (e as HTMLInputElement).readOnly)).toBe(
      false,
    );
    await present(page, [field]);
    expect(await input.getAttribute("aria-describedby")).toBeNull();
    expect(await input.getAttribute("aria-labelledby")).toBeNull();
  });

  test(`${renderer} authored reading and table structure retains one element per identity`, async ({
    page,
  }) => {
    await page.goto(`/health?renderer=${renderer}`);
    await page.addScriptTag({
      url: "/accessibility-actions.js",
      type: "module",
    });
    await page.waitForFunction(() => !!window.accessibilityActions);
    const reading: WebHostAccessibilityNode[] = [
      {
        id: "title",
        role: "group",
        label: "Results",
        rect: [0, 0, 20, 1],
        properties: { headingLevel: 3 },
      },
      {
        id: "paragraph",
        role: "group",
        label: "Bonjour le monde.",
        rect: [0, 1, 20, 2],
        properties: { textKind: "paragraph", language: "fr" },
      },
      {
        id: "table",
        role: "table",
        rect: [0, 3, 20, 5],
        properties: { rowCount: 10, columnCount: 4 },
      },
      {
        id: "row",
        parentId: "table",
        role: "tableRow",
        rect: [0, 3, 20, 1],
        properties: { rowIndex: 2 },
      },
      {
        id: "cell",
        parentId: "row",
        role: "columnHeader",
        label: "Score",
        rect: [0, 3, 10, 1],
        properties: {
          columnIndex: 3,
          rowSpan: 2,
          columnSpan: 1,
          sort: "descending",
        },
      },
    ];
    await present(page, reading);
    await expect(
      page.getByRole("heading", { name: "Results", level: 3 }),
    ).toHaveCount(1);
    const paragraph = page.getByRole("paragraph");
    await expect(paragraph).toHaveText("Bonjour le monde.");
    expect(await paragraph.getAttribute("aria-label")).toBeNull();
    await expect(page.getByRole("table")).toHaveAttribute(
      "aria-rowcount",
      "10",
    );
    await expect(page.getByRole("table")).toHaveAttribute("aria-colcount", "4");
    await expect(page.getByRole("row")).toHaveAttribute("aria-rowindex", "2");
    const cell = page.getByRole("columnheader", { name: "Score" });
    await expect(cell).toHaveAttribute("aria-colindex", "3");
    await expect(cell).toHaveAttribute("aria-rowspan", "2");
    await expect(cell).toHaveAttribute("aria-colspan", "1");
    await expect(cell).toHaveAttribute("aria-sort", "descending");
    await present(
      page,
      reading.map((node) =>
        node.id === "paragraph" ? { ...node, label: "Au revoir." } : node,
      ),
    );
    await expect(paragraph).toHaveText("Au revoir.");
    await expect(
      page.locator('[data-accessibility-id="paragraph"]'),
    ).toHaveCount(1);
    await present(
      page,
      reading.map((node) => ({ ...node, properties: undefined })),
    );
    await expect(page.getByRole("paragraph")).toHaveCount(0);
    expect(
      await page.locator('[data-accessibility-id="paragraph"]').textContent(),
    ).toBe("");
  });
}

for (const renderer of ["canvas", "dom"]) {
  for (const presentation of [
    "menu",
    "list",
    "radioGroup",
    "segmented",
  ] as const) {
    test(`${renderer} ${presentation} picker keeps typed choices and native focus`, async ({
      page,
    }) => {
      await page.goto(`/health?renderer=${renderer}`);
      await page.addScriptTag({
        url: "/accessibility-actions.js",
        type: "module",
      });
      await page.waitForFunction(() => !!window.accessibilityActions);
      const picker: WebHostAccessibilityNode = {
        id: "picker",
        actionTarget: "8:picker",
        role: "picker",
        label: "Mode",
        rect: [0, 0, 24, 6],
        actions: ["focus", "setValue"],
        value: { type: "text", value: "one" },
        selection: {
          presentation,
          options: [
            { id: "one", label: "One", isEnabled: true },
            { id: "two", label: "Two", isEnabled: true },
            { id: "three", label: "Unavailable", isEnabled: false },
          ],
        },
      };
      await present(page, [
        picker,
        { ...nodes[0], id: "after", rect: [0, 7, 10, 1] },
      ]);
      const radio =
        presentation === "radioGroup" || presentation === "segmented";
      const control = radio
        ? page.getByRole("radio", { name: "Two", exact: true })
        : page.getByRole(presentation === "menu" ? "combobox" : "listbox", {
            name: "Mode",
          });
      if (radio) {
        await page.getByRole("radio", { name: "One", exact: true }).focus();
        await page
          .getByRole("radio", { name: "One", exact: true })
          .press("ArrowRight");
        await expect(control).toBeChecked();
      } else {
        await control.focus();
        await control.selectOption("two");
        await expect(control).toHaveValue("two");
      }
      const sent = await records(page);
      expect(
        sent.filter((record) => record.includes(":setValue:")),
      ).toHaveLength(1);
      expect(sent.find((record) => record.includes(":setValue:"))).toContain(
        ":setValue:text:two",
      );
      const requestID = sent
        .find((record) => record.includes(":setValue:"))!
        .split(":")[1];
      // A frame before the action acknowledgement cannot roll back native selection.
      await present(page, [picker]);
      if (radio) await expect(control).toBeChecked();
      else await expect(control).toHaveValue("two");
      picker.value = { type: "text", value: "two" };
      picker.isFocused = true;
      await present(page, [picker], {
        requestID,
        target: picker.actionTarget!,
        result: "accepted",
      });
      await expect(control).toBeFocused();
      const disabled = page.getByRole(radio ? "radio" : "option", {
        name: "Unavailable",
      });
      await expect(disabled).toBeDisabled();
      // Reorder and relabel without replacing the selected DOM choice.
      const handle = await control.elementHandle();
      picker.selection!.options = [
        picker.selection!.options[1],
        picker.selection!.options[0],
      ];
      await present(page, [picker]);
      expect(await control.evaluate((node, old) => node === old, handle)).toBe(
        true,
      );
      await expect(control).toBeFocused();
      picker.selection!.options = picker.selection!.options.filter(
        (option) => option.id !== "two",
      );
      picker.value = { type: "text", value: "one" };
      await present(page, [picker]);
      if (radio)
        await expect(
          page.getByRole("radio", { name: "One", exact: true }),
        ).toBeFocused();
      else await expect(control).toHaveValue("one");
      expect(
        (await records(page)).filter((record) => record.includes(":setValue:")),
      ).toHaveLength(1);
    });
  }
}

for (const renderer of ["canvas", "dom"]) {
  for (const presentation of ["radioGroup", "segmented"] as const) {
    test(`${renderer} ${presentation} options use placed bounds and own pointer activation`, async ({
      page,
    }) => {
      await page.goto(`/health?renderer=${renderer}`);
      await page.addScriptTag({
        url: "/accessibility-actions.js",
        type: "module",
      });
      await page.waitForFunction(() => !!window.accessibilityActions);
      const picker: WebHostAccessibilityNode = {
        id: "placed-picker",
        parentId: "container",
        actionTarget: "9:placed-picker",
        role: "picker",
        label: "Placed choices",
        rect: [5, 2, 24, 7],
        actions: ["focus", "setValue"],
        value: { type: "text", value: "first" },
        selection: {
          presentation,
          options: [
            {
              id: "first",
              label: "First",
              isEnabled: true,
              rect: [6, 4, 4, 1],
            },
            {
              id: "second",
              label: "Second",
              isEnabled: true,
              rect:
                presentation === "radioGroup" ? [6, 5, 20, 1] : [11, 4, 15, 1],
            },
            {
              id: "disabled",
              label: "Unavailable",
              isEnabled: false,
              rect: [6, 6, 20, 1],
            },
          ],
        },
      };
      const container: WebHostAccessibilityNode = {
        id: "container",
        role: "group",
        rect: [3, 1, 30, 10],
      };
      await present(page, [container, picker]);
      const owner = page.getByRole("radiogroup", { name: "Placed choices" });
      const first = page.getByRole("radio", { name: "First", exact: true });
      const second = page.getByRole("radio", { name: "Second", exact: true });
      const assertBounds = async () => {
        const ownerBox = (await owner.boundingBox())!;
        for (const option of picker.selection!.options) {
          const box = (await page
            .getByRole("radio", { name: option.label, exact: true })
            .boundingBox())!;
          const [x, y, width, height] = option.rect!;
          expect(box.x).toBeCloseTo(
            ownerBox.x +
              ((x - picker.rect[0]) * ownerBox.width) / picker.rect[2],
            0,
          );
          expect(box.y).toBeCloseTo(
            ownerBox.y +
              ((y - picker.rect[1]) * ownerBox.height) / picker.rect[3],
            0,
          );
          expect(box.width).toBeCloseTo(
            (width * ownerBox.width) / picker.rect[2],
            0,
          );
          expect(box.height).toBeCloseTo(
            (height * ownerBox.height) / picker.rect[3],
            0,
          );
        }
      };
      await assertBounds();
      await second.click();
      await expect(second).toBeChecked();
      expect(
        (await records(page)).filter((r) => r.includes(":setValue:")),
      ).toHaveLength(1);
      await second.click();
      expect(
        (await records(page)).filter((r) => r.includes(":setValue:")),
      ).toHaveLength(1);
      const unavailable = (await page
        .getByRole("radio", { name: "Unavailable" })
        .boundingBox())!;
      await page.mouse.click(
        unavailable.x + unavailable.width / 2,
        unavailable.y + unavailable.height / 2,
      );
      await expect(second).toBeChecked();
      expect(
        (await records(page)).filter((r) => r.includes(":setValue:")),
      ).toHaveLength(1);
      expect(
        await page.evaluate(() =>
          window.accessibilityActions.inputRecords.filter((r) =>
            r.startsWith("\u001epointer:"),
          ),
        ),
      ).toEqual([]);
      // A later layout moves the same choices. Bounds must not be cached by ID.
      picker.rect[1]++;
      for (const option of picker.selection!.options) option.rect![1]++;
      await present(page, [container, picker]);
      await assertBounds();
      await first.focus();
      await first.press("Space");
      await expect(first).toBeChecked();
      expect(
        (await records(page)).filter((r) => r.includes(":setValue:")),
      ).toHaveLength(2);
    });
  }
}
