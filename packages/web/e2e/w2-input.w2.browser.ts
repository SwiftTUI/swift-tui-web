// W2 input journeys: IME composition (w2s009–w2s018) and pointer/wheel bursts
// (w2s019–w2s028). Contracts: UI Events / Composition Events specs, the web
// README input/keyboard-routing section, and HOST-WIRE-CONTRACT.md pointer and
// coalescing rules. Finding assertions encode the reproduced current behavior
// and log a W2_KNOWN_ASSERTION; under SWIFTTUI_W2_UNMARKED=1 they assert the
// contract-correct value instead (so the unmarked run shows the finding).
import { expect, type Page, test } from "@playwright/test";
import type { WebHostAccessibilityNode } from "./w2-adversarial.fixture.ts";

const UNMARKED = process.env.SWIFTTUI_W2_UNMARKED === "1";
function known(id: string, note: string): void {
  if (!UNMARKED) console.info(`W2_KNOWN_ASSERTION ${id} ${note}`);
}

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
  options: { wheelMode?: "capture" | "chain"; scrollRegion?: boolean } = {},
): Promise<void> {
  await page.evaluate(
    async ({ wheelMode, scrollRegion }) => {
      const id = await window.__w2.create({
        renderer: "canvas",
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

test("wheel momentum magnitude collapses to a unit cell delta (w2s021)", async ({
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
  if (UNMARKED) {
    // A momentum-like deltaY of 480 should carry a proportional cell delta.
    expect(Number(deltas)).toBeGreaterThan(1);
  } else {
    expect(deltas).toBe("1");
    known(
      "w2s021",
      "STUI-1191: normalizedWheelDelta collapses every wheel magnitude to +/-1; contract: wire delta is an integer cell count",
    );
  }
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

test("a canvas scene captures Ctrl+wheel and blocks browser zoom (w2s028)", async ({
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
  if (UNMARKED) {
    // README leaves Ctrl/Command+wheel to browser zoom; a canvas scene should
    // not preventDefault a pinch-zoom gesture.
    expect(result.prevented).toBe(false);
    expect(result.records).toBe(0);
  } else {
    expect(result.prevented).toBe(true);
    expect(result.records).toBe(1);
    known(
      "w2s028",
      "STUI-1190: Canvas renderer traps Ctrl+wheel (pinch-zoom) while the DOM renderer leaves it to the browser; contract: README Ctrl+wheel policy",
    );
  }
});
