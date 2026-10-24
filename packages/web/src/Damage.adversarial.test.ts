import { expect, test } from "bun:test";
import { CanvasSurfacePainter } from "./CanvasSurfacePainter.ts";
import { unionSurfaceDamage as unionCore } from "./SurfacePaintScheduler.ts";
import type {
  WebHostSurfaceDamage,
  WebHostSurfaceFrame,
} from "./WebHostSurfaceTransport.ts";
import { normalizeWebHostTerminalStyle } from "./WebHostTerminalStyle.ts";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected bounded damage");
  return value;
}

function damage(
  textRows: WebHostSurfaceDamage["textRows"],
  text = false,
  graphics = false,
): WebHostSurfaceDamage {
  return {
    textRows,
    requiresFullTextRepaint: text,
    requiresFullGraphicsReplay: graphics,
  };
}

// A finite cell-set oracle is independent of the production interval merge.
function coverage(value: WebHostSurfaceDamage): string[] {
  const cells = new Set<string>();
  for (const [y, ranges] of value.textRows) {
    for (const [start, end] of ranges.length ? ranges : [[0, 8] as const]) {
      for (let x = start; x < end; x++) cells.add(`${x},${y}`);
    }
  }
  return [...cells].sort();
}

// This records cell ownership for plain ASCII text; it does not simulate browser
// glyph rasterization. All fixture glyphs and rectangles stay inside their cells.
class CellCanvas {
  readonly cells = new Map<string, string>();
  setTransform() {}
  save() {}
  restore() {}
  beginPath() {}
  rect() {}
  clip() {}
  clearRect(x: number, y: number, width: number, height: number) {
    for (let row = y / 10; row < (y + height) / 10; row++) {
      for (let col = x / 10; col < (x + width) / 10; col++)
        this.cells.delete(`${col},${row}`);
    }
  }
  fillRect(x: number, y: number, width: number, height: number) {
    this.clearRect(x, y, width, height);
  }
  fillText(value: string, x: number, y: number) {
    this.cells.set(`${Math.floor(x / 10)},${Math.floor(y / 10)}`, value);
  }
  get canvas(): HTMLCanvasElement {
    return {
      width: 80,
      height: 30,
      getContext: () => this,
    } as unknown as HTMLCanvasElement;
  }
}

function unionSurfaceDamage(
  a: WebHostSurfaceDamage | undefined,
  b: WebHostSurfaceDamage | undefined,
) {
  const result = unionCore(a, b);
  const full =
    !a ||
    !b ||
    a.requiresFullTextRepaint ||
    b.requiresFullTextRepaint ||
    a.requiresFullGraphicsReplay ||
    b.requiresFullGraphicsReplay;
  const changed = new Set(full ? [] : [...coverage(a), ...coverage(b)]);
  const frame = (updated: boolean): WebHostSurfaceFrame => ({
    version: 2,
    width: 8,
    height: 3,
    styles: [null],
    rows: Array.from({ length: 3 }, (_, y) =>
      Array.from({ length: 8 }, (_, x) => [
        x,
        updated && (full || changed.has(`${x},${y}`)) ? "B" : "A",
        1,
        0,
      ]),
    ),
  });
  const metrics = {
    columns: 8,
    rows: 3,
    cellWidth: 10,
    cellHeight: 10,
    pixelScale: 1,
    style: normalizeWebHostTerminalStyle({ fontSize: 8 }),
  };
  const incremental = new CellCanvas(),
    reference = new CellCanvas();
  const painter = new CanvasSurfacePainter(),
    fullPainter = new CanvasSurfacePainter();
  try {
    painter.attach(incremental.canvas, () => {});
    fullPainter.attach(reference.canvas, () => {});
    painter.paint(metrics, frame(false));
    painter.paint(metrics, frame(true), result);
    fullPainter.paint(metrics, frame(true));
    const expected = Array.from({ length: 24 }, (_, cell): [string, string] => {
      const key = `${cell % 8},${Math.floor(cell / 8)}`;
      return [key, full || changed.has(key) ? "B" : "A"];
    }).sort();
    expect([...reference.cells].sort()).toEqual(expected);
    expect([...incremental.cells].sort()).toEqual(expected);
  } finally {
    painter.dispose();
    fullPainter.dispose();
  }
  return result;
}

for (let id = 31; id <= 45; id++) {
  test(`w1s${String(id).padStart(3, "0")} damage union contract`, () => {
    const a = damage([[0, [[1, 3]]]]);
    if (id === 31) {
      expect(unionSurfaceDamage(undefined, a)).toBeUndefined();
      return;
    }
    if (id === 32) {
      expect(unionSurfaceDamage(a, undefined)).toBeUndefined();
      return;
    }
    if (id === 33) {
      expect(unionSurfaceDamage(damage([]), a)).toEqual(a);
      return;
    }
    if (id === 34) {
      expect(
        required(unionSurfaceDamage(damage([[2, [[1, 3]]]]), a)).textRows.map(
          ([row]) => row,
        ),
      ).toEqual([0, 2]);
      return;
    }
    const right: Record<number, [number, number]> = {
      35: [5, 7],
      36: [3, 5],
      37: [2, 5],
      38: [0, 5],
      39: [1, 3],
    };
    if (id <= 39) {
      const b = damage([[0, [required(right[id])]]]);
      const result = required(unionSurfaceDamage(a, b));
      expect(coverage(result)).toEqual(
        [...new Set([...coverage(a), ...coverage(b)])].sort(),
      );
      expect(required(result.textRows[0])[1].length).toBe(id === 35 ? 2 : 1);
      return;
    }
    if (id === 40 || id === 41) {
      const full = damage([[0, []]]);
      expect(
        unionSurfaceDamage(id === 40 ? full : a, id === 40 ? a : full),
      ).toEqual(full);
      return;
    }
    if (id === 42 || id === 43) {
      const flagged = damage([], id === 42, id === 43);
      for (const pair of [
        [a, flagged],
        [flagged, a],
      ]) {
        expect(unionSurfaceDamage(pair[0], pair[1])).toMatchObject({
          requiresFullTextRepaint: id === 42,
          requiresFullGraphicsReplay: id === 43,
        });
      }
      return;
    }
    const b = damage([
      [0, [[2, 5]]],
      [1, [[0, 2]]],
    ]);
    const c = damage([
      [0, [[5, 7]]],
      [1, [[4, 6]]],
    ]);
    if (id === 44) {
      expect(unionSurfaceDamage(unionSurfaceDamage(a, b), c)).toEqual(
        unionSurfaceDamage(a, unionSurfaceDamage(b, c)),
      );
      expect(unionSurfaceDamage(a, b)).toEqual(unionSurfaceDamage(b, a));
      expect(unionSurfaceDamage(a, a)).toEqual(a);
      expect(
        coverage(required(unionSurfaceDamage(unionSurfaceDamage(a, b), c))),
      ).toEqual(
        [...new Set([...coverage(a), ...coverage(b), ...coverage(c)])].sort(),
      );
    } else {
      const before = JSON.stringify([a, b]);
      const freeze = (value: unknown): void => {
        if (value && typeof value === "object") {
          for (const item of Object.values(value)) freeze(item);
          Object.freeze(value);
        }
      };
      freeze(a);
      freeze(b);
      expect(coverage(required(unionSurfaceDamage(a, b)))).toEqual(
        [...new Set([...coverage(a), ...coverage(b)])].sort(),
      );
      expect(JSON.stringify([a, b])).toBe(before);
    }
  });
}
