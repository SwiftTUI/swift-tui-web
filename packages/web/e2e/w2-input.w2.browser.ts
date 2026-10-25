// W2 input journeys: IME composition (w2s009–w2s018) and pointer/wheel bursts
// (w2s019–w2s028). Contracts: UI Events / Composition Events specs, the web
// README input/keyboard-routing section, and HOST-WIRE-CONTRACT.md pointer and
// coalescing rules. Both findings (w2s021, STUI-1191; w2s028, STUI-1190) are
// repaired, so every assertion here is ordinary.
import { expect, type Frame, type Page, test } from "@playwright/test";
import type { WebHostAccessibilityNode } from "./w2-adversarial.fixture.ts";

// UI Events WheelEvent.deltaMode values (the test runner has no DOM globals).
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.addScriptTag({ url: "/w2-adversarial.js", type: "module" });
  await page.waitForFunction(() => !!window.__w2);
});
test.afterEach(async ({ page }) => {
  await page.evaluate(() => window.__w2?.disposeAll()).catch(() => {});
});

const editor: WebHostAccessibilityNode = {
  id: "editor",
  actionTarget: "editor:1",
  role: "textEditor",
  label: "Notes",
  rect: [0, 0, 20, 2],
  actions: ["focus", "setValue", "editText", "selectText"],
  value: { type: "text", value: "" },
  textSelection: [0, 0],
};

async function editorInput(
  page: Page,
  renderer: "canvas" | "dom",
): Promise<void> {
  await page.evaluate(
    async ({ renderer, node }) => {
      const id = await window.__w2.create({ renderer });
      window.__w2.presentAccessibility(id, [node]);
      await window.__w2.settle();
      (window as unknown as { __w2id: number }).__w2id = id;
    },
    { renderer, node: editor },
  );
}

for (const renderer of ["canvas", "dom"] as const) {
  test(`${renderer}: a composition sequence commits the final value exactly once (w2s00${renderer === "canvas" ? 9 : "10"})`, async ({
    page,
  }) => {
    await editorInput(page, renderer);
    const edits = await page.evaluate(() => {
      const id = (window as unknown as { __w2id: number }).__w2id;
      const input = document.querySelector<HTMLTextAreaElement>(
        '[data-accessibility-id="editor"]',
      )!;
      input.focus();
      input.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      );
      input.value = "é";
      input.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          isComposing: true,
          inputType: "insertCompositionText",
        }),
      );
      input.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true, data: "é" }),
      );
      input.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertFromComposition",
        }),
      );
      return window.__w2
        .inputs(id)
        .filter((r) => r.includes(":editText:") || r.includes(":setValue:"));
    });
    expect(edits).toHaveLength(1);
    expect(edits[0]).toContain("%C3%A9");
  });
}

test("composition survives an incoming frame without a premature commit (w2s013)", async ({
  page,
}) => {
  await editorInput(page, "dom");
  const result = await page.evaluate((node) => {
    const id = (window as unknown as { __w2id: number }).__w2id;
    const input = document.querySelector<HTMLTextAreaElement>(
      '[data-accessibility-id="editor"]',
    )!;
    input.focus();
    input.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    input.value = "preedit";
    input.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        isComposing: true,
        inputType: "insertCompositionText",
      }),
    );
    window.__w2.presentAccessibility(id, [node]); // incoming frame mid-composition
    const duringValue = input.value;
    const duringEdits = window.__w2
      .inputs(id)
      .filter(
        (r) => r.includes(":editText:") || r.includes(":setValue:"),
      ).length;
    return { duringValue, duringEdits };
  }, editor);
  // An incoming frame must not overwrite the local pre-edit or force a commit.
  expect(result.duringValue).toBe("preedit");
  expect(result.duringEdits).toBe(0);
});

test("a commit uses the native field value, not the compositionend data (w2s011)", async ({
  page,
}) => {
  await editorInput(page, "dom");
  const edits = await page.evaluate(() => {
    const id = (window as unknown as { __w2id: number }).__w2id;
    const input = document.querySelector<HTMLTextAreaElement>(
      '[data-accessibility-id="editor"]',
    )!;
    input.focus();
    input.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    input.value = "shift"; // the committed field content
    input.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        isComposing: true,
        inputType: "insertCompositionText",
      }),
    );
    input.dispatchEvent(
      new CompositionEvent("compositionend", {
        bubbles: true,
        data: "mismatch",
      }),
    );
    return window.__w2.inputs(id).filter((r) => r.includes(":editText:"));
  });
  expect(edits).toHaveLength(1);
  expect(edits[0]).toContain(":editText:text:shift:");
});

test("a committed surrogate pair survives percent-encoding intact (w2s012)", async ({
  page,
}) => {
  await editorInput(page, "dom");
  const edits = await page.evaluate(() => {
    const id = (window as unknown as { __w2id: number }).__w2id;
    const input = document.querySelector<HTMLTextAreaElement>(
      '[data-accessibility-id="editor"]',
    )!;
    input.focus();
    input.value = "\u{1F642}"; // U+1F642 (surrogate pair in UTF-16)
    input.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText" }),
    );
    return window.__w2.inputs(id).filter((r) => r.includes(":editText:"));
  });
  expect(edits).toHaveLength(1);
  expect(edits[0]).toContain("%F0%9F%99%82");
});

// Probe (not a filed finding): the shipped AccessibilityEditing suite asserts
// that a composition retired by an actionTarget change makes no edit, but that
// scenario carries prior committed value/selection state this generic harness
// does not reproduce. Here, with the node id unchanged, the element is reused,
// the pre-edit survives the mid-composition frame (composing guard) and
// compositionend commits one editText to the new target. This journey records
// that observed behavior; reconciling it against the shipped suite is left to
// the next pass.
test("a mid-composition actionTarget change commits one editText to the new target (w2s014 probe)", async ({
  page,
}) => {
  await editorInput(page, "dom");
  const result = await page.evaluate((node) => {
    const id = (window as unknown as { __w2id: number }).__w2id;
    const input = document.querySelector<HTMLTextAreaElement>(
      '[data-accessibility-id="editor"]',
    )!;
    input.focus();
    input.dispatchEvent(
      new CompositionEvent("compositionstart", { bubbles: true }),
    );
    input.value = "stale";
    window.__w2.presentAccessibility(id, [
      { ...node, actionTarget: "editor:2" },
    ]);
    const before = window.__w2
      .inputs(id)
      .filter((r) => r.includes(":editText:")).length;
    input.dispatchEvent(
      new CompositionEvent("compositionend", { bubbles: true }),
    );
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    const after = window.__w2
      .inputs(id)
      .filter((r) => r.includes(":editText:")).length;
    return { before, after, value: input.value };
  }, editor);
  expect(result.after).toBe(result.before + 1);
  expect(result.value).toBe("stale");
});

test("a precomposed single-scalar key is delivered as a character (w2s016)", async ({
  page,
}) => {
  const records = await page.evaluate(async () => {
    const id = await window.__w2.create({ renderer: "canvas" });
    window.__w2.present(id, {
      width: 4,
      height: 1,
      styles: [null],
      rows: [[[0, "....", 4, 0]]],
    });
    await window.__w2.settle();
    window.__w2.dispatchKey(id, { key: "é" }); // U+00E9, a single code point
    return window.__w2.inputs(id).filter((r) => r.startsWith("\u001ekey:"));
  });
  expect(records).toHaveLength(1);
  expect(records[0]).toContain("key:character:");
  expect(records[0]).toContain("c3%a9".toUpperCase());
});

// Probe: InputEventEncoder.encodeKey forwards only a key whose event.key is a
// single Unicode scalar; the wire key:character payload itself carries one
// scalar (WebSurfaceInputParser takes decoded.first), so dropping a multi-scalar
// grapheme keydown matches the wire shape rather than a clear contract breach.
// A real keyboard rarely fires keydown with such a key. Recorded as a probe.
test("a multi-code-point grapheme key is dropped at the encoder (w2s015 probe)", async ({
  page,
}) => {
  const count = await page.evaluate(async () => {
    const id = await window.__w2.create({ renderer: "canvas" });
    window.__w2.present(id, {
      width: 4,
      height: 1,
      styles: [null],
      rows: [[[0, "....", 4, 0]]],
    });
    await window.__w2.settle();
    window.__w2.dispatchKey(id, { key: "\u{1F469}‍\u{1F4BB}" }); // ZWJ emoji, 3 scalars
    return window.__w2.inputs(id).filter((r) => r.startsWith("\u001ekey:"))
      .length;
  });
  expect(count).toBe(0);
});

// Probe (see w2s015): a decomposed grapheme (NFD) keydown is likewise dropped.
test("a decomposed-grapheme key is dropped at the encoder (w2s017 probe)", async ({
  page,
}) => {
  const count = await page.evaluate(async () => {
    const id = await window.__w2.create({ renderer: "canvas" });
    window.__w2.present(id, {
      width: 4,
      height: 1,
      styles: [null],
      rows: [[[0, "....", 4, 0]]],
    });
    await window.__w2.settle();
    window.__w2.dispatchKey(id, { key: "é" }); // "e" + combining acute, 2 scalars
    return window.__w2.inputs(id).filter((r) => r.startsWith("\u001ekey:"))
      .length;
  });
  expect(count).toBe(0);
});

test("a paste of multi-line Unicode text is delivered percent-encoded and unsplit (w2s018)", async ({
  page,
}) => {
  const records = await page.evaluate(async () => {
    const id = await window.__w2.create({ renderer: "canvas" });
    window.__w2.present(id, {
      width: 4,
      height: 1,
      styles: [null],
      rows: [[[0, "....", 4, 0]]],
    });
    await window.__w2.settle();
    const terminal = document.querySelector<HTMLElement>(
      ".webhost-scene__terminal",
    )!;
    terminal.focus();
    const data = new DataTransfer();
    data.setData("text/plain", "Café\n漢字");
    terminal.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
    return window.__w2.inputs(id).filter((r) => r.startsWith("\u001epaste:"));
  });
  expect(records).toHaveLength(1);
  expect(records[0]).toBe("\u001epaste:Caf%C3%A9%0A%E6%BC%A2%E5%AD%97");
});

// ---- Pointer and wheel bursts ----------------------------------------------

async function capturingScene(
  page: Page,
  options: {
    wheelMode?: "capture" | "chain";
    scrollRegion?: boolean;
    renderer?: "canvas" | "dom";
  } = {},
): Promise<void> {
  await page.evaluate(
    async ({ wheelMode, scrollRegion, renderer }) => {
      const id = await window.__w2.create({
        renderer,
        wheelMode,
        mountWidth: 480,
        mountHeight: 240,
      });
      const metrics = window.__w2.cellMetrics(id)!;
      window.__w2.present(id, {
        width: metrics.columns,
        height: metrics.rows,
        styles: [null],
        rows: window.__w2.helpers.fullRows(metrics.columns, metrics.rows, "W"),
        ...(scrollRegion
          ? {
              scrollRegions: [
                {
                  id: "list",
                  rect: [0, 0, metrics.columns, metrics.rows],
                  offset: [0, 0],
                  content: [metrics.columns, metrics.rows * 4],
                },
              ],
            }
          : {}),
      });
      await window.__w2.settle();
      // Synthetic PointerEvents cannot take native capture; stub it so the host's
      // capture bookkeeping runs deterministically. Real dragging is unaffected.
      const el = document.querySelector<HTMLElement>(
        ".webhost-scene__terminal",
      )!;
      el.setPointerCapture = () => {};
      el.releasePointerCapture = () => {};
      el.hasPointerCapture = () => true;
      (window as unknown as { __w2id: number }).__w2id = id;
    },
    {
      wheelMode: options.wheelMode ?? "capture",
      scrollRegion: options.scrollRegion ?? false,
      renderer: options.renderer ?? "canvas",
    },
  );
}

test("a pointer-move burst in one task emits one record per move (no host coalescing) (w2s019)", async ({
  page,
}) => {
  await capturingScene(page);
  const count = await page.evaluate(() => {
    const id = (window as unknown as { __w2id: number }).__w2id;
    const el = document.querySelector<HTMLElement>(".webhost-scene__terminal")!;
    const rect = el.getBoundingClientRect();
    const before = window.__w2
      .mouseInputs(id)
      .filter((r) => r.includes(":moved:")).length;
    for (let i = 0; i < 60; i += 1)
      el.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          pointerId: 1,
          pointerType: "mouse",
          buttons: 0,
          clientX: rect.left + 10 + (i % 20),
          clientY: rect.top + 10,
        }),
      );
    return (
      window.__w2.mouseInputs(id).filter((r) => r.includes(":moved:")).length -
      before
    );
  });
  // Probe: the browser host emits one wire record per pointermove; the
  // documented "mouse coalescing retains one reservation" clause in
  // HOST-WIRE-CONTRACT.md governs the server's decoded-event queue, not the
  // browser encoder, so the host's lack of client-side coalescing is not a
  // clear contract breach. Recorded (adjacent STUI-842), not filed.
  expect(count).toBe(60);
});

test("a momentum wheel carries its magnitude as bounded cell deltas (w2s021)", async ({
  page,
}) => {
  await capturingScene(page, { wheelMode: "capture" });
  const deltas = await page.evaluate(() => {
    const id = (window as unknown as { __w2id: number }).__w2id;
    const el = document.querySelector<HTMLElement>(".webhost-scene__terminal")!;
    const rect = el.getBoundingClientRect();
    el.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY: 480,
        clientX: rect.left + 10,
        clientY: rect.top + 10,
      }),
    );
    const record = window.__w2
      .mouseInputs(id)
      .find((r) => r.includes(":scrolled:"))!;
    const fields = record.slice(1).split(":");
    return fields[fields.length - 2]; // deltaY field
  });
  // STUI-1191 (fixed in wave 3): the wire delta is an integer cell count. 480
  // CSS px spans more than 16 of the fixture's Canvas rows, so the record
  // carries the documented per-record bound of 16.
  expect(deltas).toBe("16");
});

// Wave 3 repair journeys for STUI-1191 (wave3web-r11..r14): real WheelEvents
// in each deltaMode over a capture-mode scene. Returns, per wheel, whether the
// runtime consumed it and the deltaY fields of the records it produced.
async function wheelDeltas(
  page: Page,
  wheels: readonly { deltaY: number; deltaMode?: number }[],
): Promise<{ prevented: boolean; deltaY: string[]; prefixes: string[] }[]> {
  return await page.evaluate((wheels) => {
    const id = (window as unknown as { __w2id: number }).__w2id;
    const el = document.querySelector<HTMLElement>(".webhost-scene__terminal");
    if (!el) throw new Error("no W2 terminal");
    const rect = el.getBoundingClientRect();
    return wheels.map(({ deltaY, deltaMode }) => {
      const before = window.__w2.mouseInputs(id).length;
      const event = new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY,
        deltaMode: deltaMode ?? WheelEvent.DOM_DELTA_PIXEL,
        clientX: rect.left + 10,
        clientY: rect.top + 10,
      });
      el.dispatchEvent(event);
      const records = window.__w2
        .mouseInputs(id)
        .slice(before)
        .filter((r) => r.includes(":scrolled:"));
      return {
        prevented: event.defaultPrevented,
        deltaY: records.map((r) => r.split(":").at(-2) ?? ""),
        prefixes: records.map((r) => r.split(":scrolled:")[0] ?? ""),
      };
    });
  }, wheels);
}

async function presentedCells(
  page: Page,
): Promise<{ cellHeight: number; rows: number }> {
  return await page.evaluate(() => {
    const id = (window as unknown as { __w2id: number }).__w2id;
    const metrics = window.__w2.cellMetrics(id);
    if (!metrics) throw new Error("no presented W2 geometry");
    return { cellHeight: metrics.cellHeight, rows: metrics.rows };
  });
}

test("a line-mode wheel sends one row per line (wave3web-r11)", async ({
  page,
}) => {
  await capturingScene(page, { wheelMode: "capture" });
  const [result] = await wheelDeltas(page, [
    { deltaY: 3, deltaMode: DOM_DELTA_LINE },
  ]);
  expect(result).toMatchObject({ prevented: true, deltaY: ["3"] });
});

test("a page-mode wheel sends the presented rows, bounded (wave3web-r12)", async ({
  page,
}) => {
  await capturingScene(page, { wheelMode: "capture" });
  const { rows } = await presentedCells(page);
  const [result] = await wheelDeltas(page, [
    { deltaY: 1, deltaMode: DOM_DELTA_PAGE },
  ]);
  expect(result).toMatchObject({
    prevented: true,
    deltaY: [String(Math.min(rows, 16))],
  });
});

test("sub-cell pixel wheels are consumed and accumulate to one row (wave3web-r13)", async ({
  page,
}) => {
  await capturingScene(page, { wheelMode: "capture" });
  const { cellHeight } = await presentedCells(page);
  const results = await wheelDeltas(page, [
    { deltaY: cellHeight / 2 },
    { deltaY: cellHeight / 2 },
  ]);
  expect(
    results.map(({ prevented, deltaY }) => ({ prevented, deltaY })),
  ).toEqual([
    { prevented: true, deltaY: [] },
    { prevented: true, deltaY: ["1"] },
  ]);
});

test("a DOM scene converts pixel wheels with its measured cell pitch (wave3web-r14)", async ({
  page,
}) => {
  await capturingScene(page, { wheelMode: "capture", renderer: "dom" });
  const { cellHeight } = await presentedCells(page);
  // 3.5 rows keeps the expectation robust to sub-pixel DOM pitch rounding.
  const [result] = await wheelDeltas(page, [{ deltaY: 3.5 * cellHeight }]);
  expect(result?.prevented).toBe(true);
  expect(result?.deltaY).toEqual(["3"]);
  expect(result?.prefixes[0]?.startsWith("\u001emouse")).toBe(true);
});

test("secondary and middle buttons encode their wire identity (w2s020)", async ({
  page,
}) => {
  await capturingScene(page);
  const buttons = await page.evaluate(() => {
    const id = (window as unknown as { __w2id: number }).__w2id;
    const el = document.querySelector<HTMLElement>(".webhost-scene__terminal")!;
    const rect = el.getBoundingClientRect();
    const press = (button: number) => {
      for (const type of ["pointerdown", "pointerup"])
        el.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            pointerId: 1,
            pointerType: "mouse",
            button,
            buttons: type === "pointerdown" ? 1 : 0,
            clientX: rect.left + 10,
            clientY: rect.top + 10,
          }),
        );
    };
    press(2);
    press(1);
    return window.__w2.mouseInputs(id);
  });
  expect(
    buttons.some((r) => r.includes(":down:") && r.includes(":secondary:")),
  ).toBe(true);
  expect(
    buttons.some((r) => r.includes(":down:") && r.includes(":middle:")),
  ).toBe(true);
});

for (const [idSuffix, ending] of [
  ["022", "pointercancel"],
  ["023", "lostpointercapture"],
] as const) {
  test(`a captured ${ending} cancels once and suppresses the stale release (w2s${idSuffix})`, async ({
    page,
  }) => {
    await capturingScene(page);
    const kinds = await page.evaluate((ending) => {
      const id = (window as unknown as { __w2id: number }).__w2id;
      const el = document.querySelector<HTMLElement>(
        ".webhost-scene__terminal",
      )!;
      const rect = el.getBoundingClientRect();
      const send = (type: string) =>
        el.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            pointerId: 1,
            pointerType: "mouse",
            button: 0,
            buttons: type === "pointerup" ? 0 : 1,
            clientX: rect.left + 10,
            clientY: rect.top + 10,
          }),
        );
      const before = window.__w2.mouseInputs(id).length;
      send("pointerdown");
      el.dispatchEvent(
        new PointerEvent(ending, { bubbles: true, pointerId: 1 }),
      );
      send("pointerup");
      send("pointerdown");
      send("pointerup");
      return window.__w2
        .mouseInputs(id)
        .slice(before)
        .map((r) => r.slice(1).split(":")[1]);
    }, ending);
    expect(kinds).toEqual(["down", "cancelled", "down", "up"]);
  });
}

test("window blur cancels a captured pointer (w2s024)", async ({ page }) => {
  await capturingScene(page);
  const kinds = await page.evaluate(() => {
    const id = (window as unknown as { __w2id: number }).__w2id;
    const el = document.querySelector<HTMLElement>(".webhost-scene__terminal")!;
    const rect = el.getBoundingClientRect();
    el.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        pointerId: 1,
        pointerType: "mouse",
        button: 0,
        buttons: 1,
        clientX: rect.left + 10,
        clientY: rect.top + 10,
      }),
    );
    window.dispatchEvent(new Event("blur"));
    return window.__w2.mouseInputs(id).map((r) => r.slice(1).split(":")[1]);
  });
  expect(kinds).toContain("cancelled");
});

test("a captured drag past the surface edge keeps finite unclamped cell coordinates (w2s025)", async ({
  page,
}) => {
  await capturingScene(page);
  const coords = await page.evaluate(() => {
    const id = (window as unknown as { __w2id: number }).__w2id;
    const el = document.querySelector<HTMLElement>(".webhost-scene__terminal")!;
    const rect = el.getBoundingClientRect();
    el.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        pointerId: 1,
        pointerType: "mouse",
        button: 0,
        buttons: 1,
        clientX: rect.left + 10,
        clientY: rect.top + 10,
      }),
    );
    el.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        pointerId: 1,
        pointerType: "mouse",
        buttons: 1,
        clientX: rect.left - 50,
        clientY: rect.top + 10,
      }),
    );
    const dragged = window.__w2
      .mouseInputs(id)
      .find((r) => r.includes(":dragged:"))!;
    return dragged.slice(1).split(":");
  });
  // rawCellLocationForEvent is intentionally unclamped during capture; the x is
  // negative but finite (documented by PointerGeometry.rawCellLocationForEvent).
  const x = Number(coords[2]);
  expect(Number.isFinite(x)).toBe(true);
  expect(x).toBeLessThan(0);
});

test("a move in the sub-cell gutter outside the grid yields no record (w2s026)", async ({
  page,
}) => {
  await capturingScene(page);
  const count = await page.evaluate(() => {
    const id = (window as unknown as { __w2id: number }).__w2id;
    const el = document.querySelector<HTMLElement>(".webhost-scene__terminal")!;
    const rect = el.getBoundingClientRect();
    const before = window.__w2.mouseInputs(id).length;
    el.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        pointerId: 1,
        pointerType: "mouse",
        buttons: 0,
        clientX: rect.left - 20,
        clientY: rect.top - 20,
      }),
    );
    return window.__w2.mouseInputs(id).length - before;
  });
  expect(count).toBe(0);
});

test("chain-mode wheel captures with headroom and falls through at the edge (w2s027)", async ({
  page,
}) => {
  await capturingScene(page, { wheelMode: "chain", scrollRegion: true });
  const result = await page.evaluate(() => {
    const id = (window as unknown as { __w2id: number }).__w2id;
    const el = document.querySelector<HTMLElement>(".webhost-scene__terminal")!;
    const rect = el.getBoundingClientRect();
    const wheel = (deltaY: number) => {
      const event = new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY,
        clientX: rect.left + 10,
        clientY: rect.top + 10,
      });
      el.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const down = wheel(120); // content taller than viewport -> headroom down
    const upAtTop = wheel(-120); // already at top -> no headroom up, falls through
    return {
      down,
      upAtTop,
      records: window.__w2
        .mouseInputs(id)
        .filter((r) => r.includes(":scrolled:")).length,
    };
  });
  expect(result.down).toBe(true);
  expect(result.upAtTop).toBe(false);
  expect(result.records).toBe(1);
});

test("a canvas scene leaves Ctrl+wheel to browser zoom (w2s028)", async ({
  page,
}) => {
  await capturingScene(page, { wheelMode: "capture" });
  const result = await page.evaluate(() => {
    const id = (window as unknown as { __w2id: number }).__w2id;
    const el = document.querySelector<HTMLElement>(".webhost-scene__terminal")!;
    const rect = el.getBoundingClientRect();
    const event = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaY: 120,
      clientX: rect.left + 10,
      clientY: rect.top + 10,
    });
    el.dispatchEvent(event);
    return {
      prevented: event.defaultPrevented,
      records: window.__w2
        .mouseInputs(id)
        .filter((r) => r.includes(":scrolled:")).length,
    };
  });
  // STUI-1190 (fixed in wave 2): README leaves Ctrl/Command+wheel to browser
  // zoom; a canvas scene must not preventDefault a pinch-zoom gesture.
  expect(result.prevented).toBe(false);
  expect(result.records).toBe(0);
});

// Wave 2 repair journeys for STUI-1190 (wave2web-r15, r16): synthetic wheels
// with each modifier over a capture-mode scene of each renderer.
async function modifiedWheels(
  page: Page,
  modifiers: readonly ("plain" | "ctrlKey" | "metaKey" | "shiftKey")[],
): Promise<Record<string, { prevented: boolean; records: string[] }>> {
  return await page.evaluate((modifiers) => {
    const id = (window as unknown as { __w2id: number }).__w2id;
    const el = document.querySelector<HTMLElement>(".webhost-scene__terminal");
    if (!el) throw new Error("no W2 terminal");
    const rect = el.getBoundingClientRect();
    const results: Record<string, { prevented: boolean; records: string[] }> =
      {};
    for (const modifier of modifiers) {
      const before = window.__w2.mouseInputs(id).length;
      const event = new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY: 120,
        clientX: rect.left + 10,
        clientY: rect.top + 10,
        ...(modifier === "plain" ? {} : { [modifier]: true }),
      });
      el.dispatchEvent(event);
      results[modifier] = {
        prevented: event.defaultPrevented,
        records: window.__w2
          .mouseInputs(id)
          .slice(before)
          .filter((r) => r.includes(":scrolled:")),
      };
    }
    return results;
  }, modifiers);
}

test("a canvas scene leaves Command+wheel to the browser (wave2web-r15)", async ({
  page,
}) => {
  await capturingScene(page, { wheelMode: "capture" });
  const result = await modifiedWheels(page, ["metaKey"]);
  expect(result.metaKey).toEqual({ prevented: false, records: [] });
});

for (const renderer of ["canvas", "dom"] as const) {
  test(`${renderer}: plain and Shift wheels stay app input${renderer === "dom" ? " and Ctrl/Command wheels go to the browser" : ""} (wave2web-r16)`, async ({
    page,
  }) => {
    await capturingScene(page, { wheelMode: "capture", renderer });
    const result = await modifiedWheels(
      page,
      renderer === "dom"
        ? ["ctrlKey", "metaKey", "plain", "shiftKey"]
        : ["plain", "shiftKey"],
    );
    if (renderer === "dom") {
      expect(result.ctrlKey).toEqual({ prevented: false, records: [] });
      expect(result.metaKey).toEqual({ prevented: false, records: [] });
    }
    expect(result.plain?.prevented).toBe(true);
    expect(result.plain?.records.map((r) => r.split(":").at(-1))).toEqual([
      "0",
    ]);
    expect(result.shiftKey?.prevented).toBe(true);
    expect(result.shiftKey?.records.map((r) => r.split(":").at(-1))).toEqual([
      "1",
    ]);
  });
}

// ---- Embedded chain-mode headroom under real wheel input (STUI-1207) --------
//
// Wave 2 root-cause journeys (wave2web-r17..r20). The counter demo's
// scroll-chaining spec embeds a geometry-negotiating producer in an iframe on a
// tall page and wheels as soon as any frame has been decoded. These journeys
// rebuild that case with this repository's fixture: a synthetic peer that
// acknowledges geometry revisions, the counter harness's host page, and real
// Chromium wheel input whose default action chains to the outer document.

type ChainPhase = "pending" | "headroom" | "edge" | "none";

async function embeddedChainScene(
  page: Page,
  phase: ChainPhase,
): Promise<{ child: Frame; x: number; y: number }> {
  await page.goto("/scroll-chain-host");
  const handle = await page.locator("iframe").elementHandle();
  const child = await handle?.contentFrame();
  if (!child) throw new Error("scroll-chain iframe did not attach");
  await child.waitForFunction(
    () => document.querySelector("#journey-root") !== null,
  );
  await child.addScriptTag({ url: "/w2-adversarial.js", type: "module" });
  await child.waitForFunction(() => !!window.__w2);
  const point = await child.evaluate(async (phase) => {
    const id = await window.__w2.create({
      renderer: "canvas",
      wheelMode: "chain",
      mountWidth: 640,
      mountHeight: 360,
    });
    const state = window as unknown as { __w2id: number; __wheels: boolean[] };
    state.__w2id = id;
    state.__wheels = [];
    // Bubble listener: runs after the runtime's own terminal handler, so it
    // records whether the runtime claimed the wheel.
    window.addEventListener(
      "wheel",
      (event) => state.__wheels.push(event.defaultPrevented),
      { passive: true },
    );
    const terminal = document.querySelector<HTMLElement>(
      ".webhost-scene__terminal",
    );
    if (!terminal) throw new Error("no W2 terminal");
    const region = (columns: number, rows: number) =>
      phase === "none"
        ? {}
        : {
            scrollRegions: [
              {
                id: "browser-scroll-chain-fixture",
                rect: [0, 0, columns, rows] as [number, number, number, number],
                offset: [0, phase === "edge" ? 20 : 0] as [number, number],
                content: [columns, rows + 20] as [number, number],
              },
            ],
          };
    // Revision-zero acknowledgement at the producer's launch grid, carrying
    // the region exactly as the counter spec's JSON.parse patch does.
    window.__w2.present(id, {
      geometryRevision: 0,
      width: 40,
      height: 12,
      rows: window.__w2.helpers.fullRows(40, 12, "W"),
      ...region(40, 12),
    });
    if (!terminal.hasAttribute("data-geometry-pending"))
      throw new Error("the acknowledgement did not start a geometry request");
    if (phase !== "pending") {
      const request = window.__w2
        .inputs(id)
        .filter((record) => record.startsWith("\u001egeometry:"))
        .at(-1);
      if (!request) throw new Error("no geometry request was sent");
      const [, revision = 0, columns = 1, rows = 1] = request
        .split(":")
        .map(Number);
      window.__w2.present(id, {
        geometryRevision: revision,
        width: columns,
        height: rows,
        rows: window.__w2.helpers.fullRows(columns, rows, "W"),
        ...region(columns, rows),
      });
    }
    const rect = terminal.getBoundingClientRect();
    return { x: rect.left + 10, y: rect.top + 10 };
  }, phase);
  if (phase !== "pending")
    // Producer-owned presentation signal: the runtime painted the requested
    // geometry and cleared its geometry wait (WebHostSceneRuntime.paint).
    await child.waitForFunction(() => {
      const id = (window as unknown as { __w2id: number }).__w2id;
      const terminal = document.querySelector(".webhost-scene__terminal");
      const statistics = window.__w2.paintStatistics(id);
      return (
        !terminal?.hasAttribute("data-geometry-pending") &&
        !statistics.pending &&
        statistics.paints > 0 &&
        window.__w2.geometry(id)?.sourceRevision !== undefined
      );
    });
  const frame = await page.locator("iframe").boundingBox();
  if (!frame) throw new Error("scroll-chain iframe has no bounds");
  return { child, x: frame.x + point.x, y: frame.y + point.y };
}

async function realWheel(
  page: Page,
  scene: { child: Frame; x: number; y: number },
): Promise<{ prevented: boolean; records: number }> {
  await page.mouse.move(scene.x, scene.y);
  await page.mouse.wheel(0, 400);
  await scene.child.waitForFunction(
    () => (window as unknown as { __wheels: boolean[] }).__wheels.length > 0,
  );
  return await scene.child.evaluate(() => {
    const state = window as unknown as { __w2id: number; __wheels: boolean[] };
    return {
      prevented: state.__wheels[0] === true,
      records: window.__w2
        .mouseInputs(state.__w2id)
        .filter((record) => record.includes(":scrolled:")).length,
    };
  });
}

async function outerScrollAfterFrames(page: Page): Promise<number> {
  return await page.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    return window.scrollY;
  });
}

test("embedded chain headroom keeps a real wheel once its geometry is presented (wave2web-r17)", async ({
  page,
}) => {
  const scene = await embeddedChainScene(page, "headroom");
  const result = await realWheel(page, scene);
  expect(result).toEqual({ prevented: true, records: 1 });
  expect(await outerScrollAfterFrames(page)).toBe(0);
});

test("a real wheel before the requested geometry is presented chains to the outer page (wave2web-r18)", async ({
  page,
}) => {
  // The counter-demo failure state: a decoded revision-zero frame publishes
  // headroom, but no frame at the requested geometry has been painted, so no
  // region is visible and pointer input is not yet routed (README geometry
  // revisions; HostGeometrySession.allowsPointer).
  const scene = await embeddedChainScene(page, "pending");
  const result = await realWheel(page, scene);
  expect(result).toEqual({ prevented: false, records: 0 });
  await page.waitForFunction(() => window.scrollY > 0);
});

for (const phase of ["edge", "none"] as const) {
  test(`a presented ${phase === "edge" ? "region at its scroll edge" : "scene without scroll regions"} chains a real wheel to the outer page (wave2web-${phase === "edge" ? "r19" : "r20"})`, async ({
    page,
  }) => {
    const scene = await embeddedChainScene(page, phase);
    const result = await realWheel(page, scene);
    expect(result).toEqual({ prevented: false, records: 0 });
    await page.waitForFunction(() => window.scrollY > 0);
  });
}

// ---- Wave-2 regression hunt, part CB (STUI-1165) ---------------------------
//
// Neighbours of the STUI-1190 renderer-independent Ctrl/Command+wheel bypass.
// The coordination root's wave-2 hunt evidence owns the case descriptions
// (w2cb007, w2cb008).

for (const renderer of ["canvas", "dom"] as const) {
  test(`w2cb007 ${renderer}: Ctrl/Command+wheel over chain headroom stays with the browser`, async ({
    page,
  }) => {
    await capturingScene(page, {
      wheelMode: "chain",
      scrollRegion: true,
      renderer,
    });
    const result = await modifiedWheels(page, ["ctrlKey", "metaKey", "plain"]);
    expect(result.ctrlKey).toEqual({ prevented: false, records: [] });
    expect(result.metaKey).toEqual({ prevented: false, records: [] });
    expect(result.plain?.prevented).toBe(true);
    expect(result.plain?.records.map((r) => r.split(":").at(-1))).toEqual([
      "0",
    ]);
  });
}

test("w2cb008 a real Control-held wheel over presented chain headroom stays with the browser", async ({
  page,
}) => {
  const scene = await embeddedChainScene(page, "headroom");
  const observe = async (count: number) => {
    await scene.child.waitForFunction(
      (count) =>
        (window as unknown as { __wheels: boolean[] }).__wheels.length >= count,
      count,
    );
    return await scene.child.evaluate(() => {
      const state = window as unknown as {
        __w2id: number;
        __wheels: boolean[];
      };
      return {
        prevented: state.__wheels.at(-1) === true,
        records: window.__w2
          .mouseInputs(state.__w2id)
          .filter((record) => record.includes(":scrolled:")).length,
      };
    });
  };
  await page.mouse.move(scene.x, scene.y);
  // A plain real wheel first proves routing is live over the presented region.
  await page.mouse.wheel(0, 400);
  const plain = await observe(1);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, 400);
  const controlHeld = await observe(2);
  await page.keyboard.up("Control");
  expect(plain).toEqual({ prevented: true, records: 1 });
  expect(controlHeld).toEqual({ prevented: false, records: 1 });
});
