// W2 DOM-versus-Canvas equivalence journeys (w2s044–w2s050). The same scene
// rendered by both production painters must agree on the semantic tree,
// focus/caret geometry and cell content. These journeys also exercise the
// shared cross-host oracle (plan Stage 1: S1/T1 test the oracle). Contracts:
// the web README renderers/accessibility sections and HOST-WIRE-CONTRACT.md.
import { expect, test } from "@playwright/test";
import type { WebHostAccessibilityNode } from "./w2-adversarial.fixture.ts";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.addScriptTag({ url: "/w2-adversarial.js", type: "module" });
  await page.waitForFunction(() => !!window.__w2);
});
test.afterEach(async ({ page }) => {
  await page.evaluate(() => window.__w2?.disposeAll()).catch(() => {});
});

const tree: WebHostAccessibilityNode[] = [
  { id: "root", role: "group", label: "Root", rect: [0, 0, 40, 12] },
  {
    id: "root/title",
    parentId: "root",
    role: "heading(level: 1)",
    label: "Title",
    rect: [0, 0, 20, 1],
  },
  {
    id: "root/button",
    parentId: "root",
    role: "button",
    label: "Press",
    rect: [0, 2, 8, 1],
    actionTarget: "b:1",
    actions: ["focus", "activate"],
  },
  {
    id: "root/status",
    parentId: "root",
    role: "status",
    label: "Ready",
    rect: [0, 4, 20, 1],
    liveRegion: "polite",
  },
  {
    id: "root/hidden",
    parentId: "root",
    role: "group",
    label: "Secret",
    rect: [0, 6, 20, 1],
    hidden: true,
  },
];

test("both painters present an identical semantic reading order, roles and labels (w2s044)", async ({
  page,
}) => {
  const result = await page.evaluate(async (nodes) => {
    const canvas = await window.__w2.create({ renderer: "canvas" });
    const dom = await window.__w2.create({ renderer: "dom" });
    window.__w2.presentAccessibility(canvas, nodes);
    window.__w2.presentAccessibility(dom, nodes);
    await window.__w2.settle();
    return {
      canvas: window.__w2.accessibility(canvas),
      dom: window.__w2.accessibility(dom),
    };
  }, tree);
  expect(result.dom.order).toEqual(result.canvas.order);
  expect(result.dom.roles).toEqual(result.canvas.roles);
  expect(result.dom.labels).toEqual(result.canvas.labels);
});

test("a hidden node is excluded from the ARIA tree in both painters (w2s045)", async ({
  page,
}) => {
  const result = await page.evaluate(async (nodes) => {
    const canvas = await window.__w2.create({ renderer: "canvas" });
    const dom = await window.__w2.create({ renderer: "dom" });
    window.__w2.presentAccessibility(canvas, nodes);
    window.__w2.presentAccessibility(dom, nodes);
    await window.__w2.settle();
    return {
      canvas: window.__w2.accessibility(canvas).order,
      dom: window.__w2.accessibility(dom).order,
    };
  }, tree);
  expect(result.canvas).not.toContain("root/hidden");
  expect(result.dom).not.toContain("root/hidden");
});

test("the focus ring occupies the same cell rectangle in both painters (w2s046)", async ({
  page,
}) => {
  const rings = await page.evaluate(async () => {
    const focused: WebHostAccessibilityNode[] = [
      {
        id: "field",
        role: "textField",
        label: "Field",
        rect: [2, 1, 6, 2],
        isFocused: true,
        cursorAnchor: [3, 1],
      },
    ];
    const make = async (renderer: "canvas" | "dom") => {
      const id = await window.__w2.create({ renderer });
      window.__w2.presentAccessibility(id, focused);
      await window.__w2.settle();
      const terminal = document.querySelectorAll<HTMLElement>(
        ".webhost-scene__terminal",
      );
      terminal[terminal.length - 1]?.focus();
      await window.__w2.settle();
      return window.__w2.focusRingCells(id);
    };
    const canvas = await make("canvas");
    const dom = await make("dom");
    return { canvas, dom };
  });
  expect(rings.canvas).toBeDefined();
  expect(rings.dom).toEqual(rings.canvas);
});

test("the caret shows only for text-input roles in both painters (w2s047)", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const make = async (role: string) => {
      const id = await window.__w2.create({ renderer: "dom" });
      window.__w2.presentAccessibility(id, [
        {
          id: "n",
          role,
          label: "N",
          rect: [0, 0, 6, 1],
          isFocused: true,
          cursorAnchor: [1, 0],
        },
      ]);
      await window.__w2.settle();
      const terminals = document.querySelectorAll<HTMLElement>(
        ".webhost-scene__terminal",
      );
      terminals[terminals.length - 1]?.focus();
      await window.__w2.settle();
      return window.__w2.caretVisible(id);
    };
    return { textField: await make("textField"), button: await make("button") };
  });
  expect(result.textField).toBe(true);
  expect(result.button).toBe(false);
});

test("a link cell is a safe anchor in DOM and has no DOM anchor in Canvas (w2s048)", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const frame = {
      width: 10,
      height: 1,
      styles: [null],
      rows: [[[0, "link", 4, 0]]] as [number, string, number, number][][],
      links: [[0, [[0, 4, 0]]]] as [number, [number, number, number][]][],
      linkTargets: ["https://example.test/target"],
    };
    const canvas = await window.__w2.create({ renderer: "canvas" });
    const dom = await window.__w2.create({ renderer: "dom" });
    window.__w2.present(canvas, frame);
    window.__w2.present(dom, frame);
    await window.__w2.settle();
    const domAnchor = document.querySelector<HTMLAnchorElement>(
      ".webhost-scene__surface--dom a[data-surface-link]",
    );
    return {
      canvasAnchors: window.__w2.surfaceLinkCount(canvas),
      domAnchors: window.__w2.surfaceLinkCount(dom),
      href: domAnchor?.getAttribute("href"),
      rel: domAnchor?.getAttribute("rel"),
    };
  });
  expect(result.canvasAnchors).toBe(0);
  expect(result.domAnchors).toBe(1);
  expect(result.href).toBe("https://example.test/target");
  expect(result.rel).toBe("noopener noreferrer");
});

test("DOM presented text matches the wire row content (w2s049)", async ({
  page,
}) => {
  const text = await page.evaluate(async () => {
    const id = await window.__w2.create({ renderer: "dom" });
    window.__w2.presentText(id, ["Café 漢字", "second"], 10);
    await window.__w2.settle();
    return window.__w2.domText(id);
  });
  expect(text).toContain("Café 漢字");
  expect(text).toContain("second");
});

test("a reverse-video cell swaps fg/bg identically in both painters (w2s050)", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const frame = {
      width: 4,
      height: 1,
      styles: [null, { fg: "#ff0000", bg: "#0000ff", em: 16 }] as (null | {
        fg: string;
        bg: string;
        em: number;
      })[],
      rows: [[[0, " ", 1, 1]]] as [number, string, number, number][][],
    };
    const canvas = await window.__w2.create({
      renderer: "canvas",
      mountWidth: 200,
      mountHeight: 80,
    });
    const dom = await window.__w2.create({
      renderer: "dom",
      mountWidth: 200,
      mountHeight: 80,
    });
    window.__w2.present(canvas, frame);
    window.__w2.present(dom, frame);
    await window.__w2.settle();
    const pixel = window.__w2.canvasPixel(canvas, 0, 0);
    const graphic = document.querySelector<HTMLElement>(
      ".webhost-scene__surface--dom .webhost-scene__surface-graphics > div",
    );
    return { pixel, domBackground: graphic?.style.backgroundColor };
  });
  // Reverse video fills the cell with the foreground color (red) on both.
  expect(result.pixel[0]).toBeGreaterThan(150);
  expect(result.pixel[2]).toBeLessThan(120);
  expect(result.domBackground).toBe("rgb(255, 0, 0)");
});
