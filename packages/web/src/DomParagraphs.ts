import type { SurfaceMetrics } from "./SurfaceRenderer.ts";
import type {
  WebHostSurfaceCell,
  WebHostSurfaceFrame,
} from "./WebHostSurfaceTransport.ts";

interface Fragment {
  start: number;
  end: number;
  owner: number;
  element: HTMLElement;
  separator?: Text;
}

/** Paragraphs own the existing visible runs; the browser never lays out their text. */
export class DomParagraphs {
  readonly key: string;
  readonly rows: Fragment[][] = [];
  private readonly owners: Int32Array;
  private readonly width: number;

  constructor(frame: WebHostSurfaceFrame, layer: HTMLElement) {
    this.width = frame.width;
    this.key = JSON.stringify([frame.width, frame.height, frame.paragraphs]);
    this.owners = new Int32Array(frame.width * frame.height);
    const roots: { y: number; x: number; element: HTMLElement }[] = [];
    const paragraphs = (frame.paragraphs ?? []).map((paragraph, index) => {
      const element = document.createElement("p");
      element.className = "webhost-scene__paragraph";
      element.setAttribute("data-paragraph-id", paragraph.id);
      // A real semantic grouping with no browser-owned block box. Swift reserves
      // the computed margin as whole rows in the next correlated layout.
      Object.assign(element.style, {
        display: "contents",
        margin: "0",
        font: "inherit",
      });
      const [x, y, w, h] = paragraph.rect;
      roots.push({ x, y, element });
      for (let row = y; row < y + h; row++)
        this.owners.fill(
          index + 1,
          row * frame.width + x,
          row * frame.width + x + w,
        );
      return element;
    });
    for (let y = 0; y < frame.rows.length; y++) {
      const fragments: Fragment[] = [];
      for (let x = 0; x < frame.width; ) {
        const start = x,
          owner = this.owners[y * frame.width + x]!;
        while (x < frame.width && this.owners[y * frame.width + x] === owner)
          x++;
        const element = document.createElement("span");
        const fragment: Fragment = { start, end: x, owner, element };
        // Each fragment contains one contiguous slice of a raster row. Explicit
        // separators keep copy deterministic when native serializers add blocks.
        if (owner || (x === frame.width && y < frame.rows.length - 1)) {
          fragment.separator = document.createTextNode("\n");
          element.appendChild(fragment.separator);
        }
        if (owner) paragraphs[owner - 1]!.appendChild(element);
        else roots.push({ x: start, y, element });
        fragments.push(fragment);
      }
      this.rows.push(fragments);
    }
    roots.sort((a, b) => a.y - b.y || a.x - b.x);
    for (const root of roots) layer.appendChild(root.element);
    // Preserve the raster text's exact final offset: a paragraph boundary is a
    // separator between visible fragments, not an extra trailing copy byte.
    const lastRoot = roots.at(-1)?.element;
    const lastElement =
      lastRoot?.tagName === "P"
        ? lastRoot.children[lastRoot.children.length - 1]
        : lastRoot;
    for (const row of this.rows) {
      const last = row.find((fragment) => fragment.element === lastElement);
      if (last?.separator) {
        last.separator.remove();
        last.separator = undefined;
      }
    }
  }

  owner(y: number, x: number): number {
    return this.owners[y * this.width + x] ?? 0;
  }

  split(y: number, cell: WebHostSurfaceCell): WebHostSurfaceCell[] {
    const [x, text, span, style] = cell;
    // ASCII batched runs can cross a paragraph edge. A supplied Unicode cluster
    // remains indivisible, including a wide cluster clipped at the viewport.
    if (text.length !== span || !/^[\x20-\x7e]*$/.test(text)) return [cell];
    const result: WebHostSurfaceCell[] = [];
    let start = x;
    for (let column = x + 1; column <= x + span; column++) {
      if (
        column === x + span ||
        this.owner(y, column) !== this.owner(y, start)
      ) {
        result.push([
          start,
          text.slice(start - x, column - x),
          column - start,
          style,
        ]);
        start = column;
      }
    }
    return result;
  }

  fragment(y: number, x: number): Fragment {
    return this.rows[y]!.find((item) => x >= item.start && x < item.end)!;
  }

  restyle(
    metrics: SurfaceMetrics,
    styleRow: (
      element: HTMLElement,
      y: number,
      metrics: SurfaceMetrics,
      start: number,
      columns: number,
    ) => void,
  ): void {
    for (const [y, fragments] of this.rows.entries())
      for (const fragment of fragments) {
        // Disjoint fragments must also have disjoint hit boxes. A full-width
        // trailing blank fragment would intercept native selection over the
        // paragraph even though its visible glyphs are positioned correctly.
        styleRow(
          fragment.element,
          y,
          metrics,
          fragment.start,
          fragment.end - fragment.start,
        );
      }
  }
}
