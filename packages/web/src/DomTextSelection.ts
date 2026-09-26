import type {
  WebHostAccessibilityNode,
  WebHostSurfaceCell,
  WebHostSurfaceFrame,
} from "./WebHostSurfaceTransport.ts";

const textInputs = new Set(["textField", "textEditor"]);
const controls = new Set([
  "button",
  "checkbox",
  "disclosureGroup",
  "image",
  "link",
  "menuItem",
  "picker",
  "progressBar",
  "secureField",
  "separator",
  "slider",
  "stepper",
  "tab",
  "toggle",
]);

/** Selection follows painted text, excluding semantic controls and link runs.
 * Plain Text has no distinct wire role; structural groups must not mask it.
 */
export class DomTextSelection {
  private readonly blocked = new Map<number, [number, number][]>();
  private readonly fields: WebHostAccessibilityNode[] = [];
  readonly key: string;

  constructor(frame?: WebHostSurfaceFrame) {
    const add = (y: number, start: number, end: number) => {
      start = Math.max(0, start);
      end = Math.min(frame?.width ?? 0, end);
      if (end <= start) return;
      const row = this.blocked.get(y) ?? [];
      row.push([start, end]);
      this.blocked.set(y, row);
    };
    for (const node of frame?.accessibilityTree ?? []) {
      if (node.hidden) continue;
      if (textInputs.has(node.role)) {
        this.fields.push(node);
        continue;
      }
      if (
        !controls.has(node.role) &&
        !node.actions?.some((action) =>
          ["activate", "increment", "decrement", "setValue"].includes(action),
        )
      )
        continue;
      const [x, y, width, height] = node.rect;
      for (
        let row = Math.max(0, y);
        row < Math.min(frame!.height, y + height);
        row++
      )
        add(row, x, x + width);
    }
    for (const [y, runs] of frame?.links ?? [])
      for (const [x, width] of runs) add(y, x, x + width);
    for (const [y, ranges] of this.blocked) {
      ranges.sort((a, b) => a[0] - b[0]);
      const merged: [number, number][] = [];
      for (const range of ranges) {
        const last = merged.at(-1);
        if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
        else merged.push([...range]);
      }
      this.blocked.set(y, merged);
    }
    this.key = JSON.stringify([...this.blocked].sort((a, b) => a[0] - b[0]));
  }

  allows(y: number, x: number, span = 1): boolean {
    return !this.blocked
      .get(y)
      ?.some(([start, end]) => x < end && x + span > start);
  }

  isTextInput(y: number, x: number): boolean {
    return this.fields.some(
      ({ rect: [left, top, width, height], isEnabled }) =>
        isEnabled !== false &&
        x >= left &&
        x < left + width &&
        y >= top &&
        y < top + height,
    );
  }

  /** Split ASCII runs before shaping/coalescing; never split a Unicode cluster. */
  split(y: number, cell: WebHostSurfaceCell): WebHostSurfaceCell[] {
    const [x, text, span, style] = cell;
    if (text.length !== span || !/^[\x20-\x7e]+$/.test(text)) return [cell];
    const cuts = new Set([x, x + span]);
    for (const range of this.blocked.get(y) ?? [])
      for (const edge of range) if (edge > x && edge < x + span) cuts.add(edge);
    const edges = [...cuts].sort((a, b) => a - b);
    return edges.slice(1).map((end, i) => {
      const start = edges[i]!;
      return [start, text.slice(start - x, end - x), end - start, style];
    });
  }
}
