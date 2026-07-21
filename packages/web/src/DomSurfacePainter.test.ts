import { expect, test } from "bun:test";

import { DomSurfacePainter } from "./DomSurfacePainter.ts";
import type { SurfaceMetrics } from "./SurfaceRenderer.ts";
import { normalizeWebHostTerminalStyle } from "./WebHostTerminalStyle.ts";
import type { WebHostSurfaceFrame } from "./WebHostSurfaceTransport.ts";

test("full paint renders positioned row and cell elements with resolved styles", () => {
  const dom = installFakeDOM();
  try {
    const painter = new DomSurfacePainter();
    const root = new FakeElement("div");
    painter.attach(root as unknown as HTMLElement);

    const frame = makeFrame({
      styles: [
        null,
        { fg: "#ff0000", bg: "#00ff00", em: 3 },
        { fg: "#123456", em: 16 },
        { underline: { pattern: "curly", color: "#abcdef" }, opacity: 0.5 },
      ],
      rows: [
        [
          [0, "Hi", 2, 1],
          [4, "rev", 3, 2],
        ],
        [
          [2, "under", 5, 3],
        ],
      ],
    });
    painter.paint(metricsFor(2), frame);

    const [rowsLayer, imagesLayer] = root.children;
    expect(rowsLayer?.className).toBe("webhost-scene__surface-rows");
    expect(imagesLayer?.className).toBe("webhost-scene__surface-images");
    expect(rowsLayer?.children).toHaveLength(2);

    const firstRow = rowsLayer?.children[0];
    expect(firstRow?.style.top).toBe("0px");
    expect(firstRow?.style.height).toBe("18px");
    expect(firstRow?.children).toHaveLength(2);

    const emphasized = firstRow?.children[0];
    expect(emphasized?.textContent).toBe("Hi");
    expect(emphasized?.style.left).toBe("0px");
    expect(emphasized?.style.width).toBe("16px");
    expect(emphasized?.style.color).toBe("#ff0000");
    expect(emphasized?.style.backgroundColor).toBe("#00ff00");
    expect(emphasized?.style.fontWeight).toBe("700");
    expect(emphasized?.style.fontStyle).toBe("italic");

    // Reverse video (em & 16) swaps the cell's colors against the theme.
    const reversed = firstRow?.children[1];
    expect(reversed?.style.left).toBe("32px");
    expect(reversed?.style.backgroundColor).toBe("#123456");

    const decorated = rowsLayer?.children[1]?.children[0];
    expect(decorated?.style.top).toBe("0");
    expect(rowsLayer?.children[1]?.style.top).toBe("18px");
    expect(decorated?.style.textDecorationLine).toBe("underline");
    expect(decorated?.style.textDecorationStyle).toBe("wavy");
    expect(decorated?.style.textDecorationColor).toBe("#abcdef");
    expect(decorated?.style.opacity).toBe("0.5");
  } finally {
    dom.restore();
  }
});

test("root style pins the grid: line height, ligatures, and letter-spacing correction", () => {
  const dom = installFakeDOM({ measuredAdvance: 7.5 });
  try {
    const painter = new DomSurfacePainter();
    const root = new FakeElement("div");
    painter.attach(root as unknown as HTMLElement);
    painter.paint(metricsFor(2), makeFrame({ rows: [[[0, "x", 1, 0]]], styles: [null] }));

    expect(root.style.lineHeight).toBe("18px");
    expect(root.style.fontVariantLigatures).toBe("none");
    expect(root.style.userSelect).toBe("text");
    // cellWidth 8 - measured advance 7.5 → each glyph stretched to the cell.
    expect(root.style.letterSpacing).toBe("0.5px");
    // The same backgroundOpacity-folded color the canvas painter fills with.
    expect(root.style.background).toBe("rgba(30, 34, 42, 1)");
  } finally {
    dom.restore();
  }
});

test("blank runs are skipped unless they carry background or decoration", () => {
  const dom = installFakeDOM();
  try {
    const painter = new DomSurfacePainter();
    const root = new FakeElement("div");
    painter.attach(root as unknown as HTMLElement);

    const frame = makeFrame({
      styles: [null, { bg: "#222222" }],
      rows: [
        [
          [0, " ", 1, 0],
          [1, "   ", 3, 1],
        ],
      ],
    });
    painter.paint(metricsFor(1), frame);

    const row = root.children[0]?.children[0];
    expect(row?.children).toHaveLength(1);
    expect(row?.children[0]?.style.backgroundColor).toBe("#222222");
    expect(row?.children[0]?.style.width).toBe("24px");
  } finally {
    dom.restore();
  }
});

test("damage-scoped paints rebuild only the damaged rows", () => {
  const dom = installFakeDOM();
  try {
    const painter = new DomSurfacePainter();
    const root = new FakeElement("div");
    painter.attach(root as unknown as HTMLElement);

    const first = makeFrame({
      styles: [null],
      rows: [
        [[0, "one", 3, 0]],
        [[0, "two", 3, 0]],
      ],
    });
    painter.paint(metricsFor(2), first);

    const rowsLayer = root.children[0];
    const untouchedRow = rowsLayer?.children[0];
    const untouchedCell = untouchedRow?.children[0];

    const second = makeFrame({
      styles: [null],
      rows: [
        [[0, "one", 3, 0]],
        [[0, "TWO", 3, 0]],
      ],
      damage: {
        textRows: [[1, []]],
        requiresFullTextRepaint: false,
        requiresFullGraphicsReplay: false,
      },
    });
    painter.paint(metricsFor(2), second, second.damage);

    // Row 0's cell element is untouched (same identity); row 1 was rebuilt.
    expect(rowsLayer?.children[0]?.children[0]).toBe(untouchedCell as FakeElement);
    expect(rowsLayer?.children[1]?.children[0]?.textContent).toBe("TWO");
  } finally {
    dom.restore();
  }
});

test("full-repaint damage and grid growth rebuild every row", () => {
  const dom = installFakeDOM();
  try {
    const painter = new DomSurfacePainter();
    const root = new FakeElement("div");
    painter.attach(root as unknown as HTMLElement);

    painter.paint(metricsFor(1), makeFrame({ styles: [null], rows: [[[0, "a", 1, 0]]] }));
    const rowsLayer = root.children[0];
    expect(rowsLayer?.children).toHaveLength(1);

    const grown = makeFrame({
      width: 8,
      height: 3,
      styles: [null],
      rows: [
        [[0, "a", 1, 0]],
        [[0, "b", 1, 0]],
        [[0, "c", 1, 0]],
      ],
      damage: {
        textRows: [[2, []]],
        requiresFullTextRepaint: false,
        requiresFullGraphicsReplay: false,
      },
    });
    // Damage names only row 2, but the grid changed shape — every row lands.
    painter.paint(metricsFor(3), grown, grown.damage);
    expect(rowsLayer?.children).toHaveLength(3);
    expect(rowsLayer?.children[1]?.children[0]?.textContent).toBe("b");
  } finally {
    dom.restore();
  }
});

test("surface images render as clipped elements and reconcile by id", () => {
  const dom = installFakeDOM();
  try {
    const painter = new DomSurfacePainter();
    const root = new FakeElement("div");
    painter.attach(root as unknown as HTMLElement);

    const withImage = makeFrame({
      styles: [null],
      rows: [[]],
      images: [
        {
          id: "img-1",
          format: "png" as const,
          bounds: [1, 0, 4, 2] as [number, number, number, number],
          visibleBounds: [2, 0, 3, 2] as [number, number, number, number],
          scalingMode: "stretch" as const,
          dataBase64: "QUJD",
        },
      ],
    });
    painter.paint(metricsFor(2), withImage);

    const imagesLayer = root.children[1];
    expect(imagesLayer?.children).toHaveLength(1);
    const container = imagesLayer?.children[0];
    expect(container?.style.left).toBe("16px");
    expect(container?.style.width).toBe("24px");
    expect(container?.style.overflow).toBe("hidden");
    const image = container?.children[0];
    expect(image?.style.left).toBe("-8px");
    expect(image?.style.width).toBe("32px");
    expect(image?.getAttribute("src")).toBe("data:image/png;base64,QUJD");

    const withoutImage = makeFrame({ styles: [null], rows: [[]] });
    painter.paint(metricsFor(2), withoutImage);
    expect(imagesLayer?.children).toHaveLength(0);
  } finally {
    dom.restore();
  }
});

test("painting an undefined frame clears the surface", () => {
  const dom = installFakeDOM();
  try {
    const painter = new DomSurfacePainter();
    const root = new FakeElement("div");
    painter.attach(root as unknown as HTMLElement);

    painter.paint(metricsFor(1), makeFrame({ styles: [null], rows: [[[0, "a", 1, 0]]] }));
    expect(root.children[0]?.children).toHaveLength(1);

    painter.paint(metricsFor(1), undefined);
    expect(root.children[0]?.children).toHaveLength(0);
  } finally {
    dom.restore();
  }
});

// ---------------------------------------------------------------------------
// Fixtures

function metricsFor(
  rows: number
): SurfaceMetrics {
  return {
    columns: 8,
    rows,
    cellWidth: 8,
    cellHeight: 18,
    style: normalizeWebHostTerminalStyle({}),
  };
}

function makeFrame(
  overrides: Partial<WebHostSurfaceFrame>
): WebHostSurfaceFrame {
  return {
    version: 2,
    width: 8,
    height: overrides.rows?.length ?? 2,
    styles: [],
    rows: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake DOM

interface FakeDOMOptions {
  measuredAdvance?: number;
}

function installFakeDOM(
  options: FakeDOMOptions = {}
): { restore(): void } {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement: (tagName: string) => {
      if (tagName === "canvas") {
        return new FakeCanvasElement(options.measuredAdvance ?? 8);
      }
      return new FakeElement(tagName);
    },
  } as unknown as Document;

  return {
    restore: () => {
      globalThis.document = previousDocument;
    },
  };
}

class FakeStyle {
  [key: string]: unknown;
}

class FakeElement {
  readonly tagName: string;
  readonly style = new FakeStyle() as unknown as CSSStyleDeclaration;
  children: FakeElement[] = [];
  parent?: FakeElement;
  className = "";
  textContent = "";

  private readonly attributes = new Map<string, string>();

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  appendChild(
    child: FakeElement
  ): FakeElement {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  replaceChildren(
    ...children: FakeElement[]
  ): void {
    for (const child of children) {
      child.parent = this;
    }
    this.children.splice(0, this.children.length, ...children);
  }

  remove(): void {
    const siblings = this.parent?.children;
    if (!siblings) {
      return;
    }
    const index = siblings.indexOf(this);
    if (index >= 0) {
      siblings.splice(index, 1);
    }
  }

  setAttribute(
    name: string,
    value: string
  ): void {
    this.attributes.set(name, value);
  }

  getAttribute(
    name: string
  ): string | null {
    return this.attributes.get(name) ?? null;
  }
}

class FakeCanvasElement extends FakeElement {
  private readonly advance: number;

  constructor(advance: number) {
    super("canvas");
    this.advance = advance;
  }

  getContext(
    contextId: string
  ): { font: string; measureText(text: string): { width: number } } | undefined {
    if (contextId !== "2d") {
      return undefined;
    }
    const advance = this.advance;
    return {
      font: "",
      measureText: (text: string) => ({
        width: Math.max(1, Array.from(text).length) * advance,
      }),
    };
  }
}
