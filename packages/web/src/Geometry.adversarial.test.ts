import { expect, test } from "bun:test";
import type { DomCellMeasurement } from "./DomCellMetrics.ts";
import { type DomContentBox, makeDomGeometry } from "./DomGeometry.ts";
import {
  cellLocationForEvent,
  linkTargetAt,
  type PointerGeometryMetrics,
  rawCellLocationForEvent,
  wheelTargetCanScroll,
} from "./PointerGeometry.ts";
import type { WebHostScrollRegion } from "./WebHostSurfaceTransport.ts";

const baseCells: DomCellMeasurement = {
  width: 8,
  height: 16,
  advance: 8,
  baseline: 12,
  fontSize: 14,
};
const baseBox: DomContentBox = {
  width: 32,
  height: 32,
  left: 10,
  top: 20,
  offsetX: 0,
  offsetY: 0,
  scaleX: 1,
  scaleY: 1,
};

for (let id = 1; id <= 15; id++) {
  test(`w1s${String(id).padStart(3, "0")} geometry snapshot contract`, () => {
    const cells = { ...baseCells };
    const box = { ...baseBox };
    let revision = 1;
    switch (id) {
      case 2:
        cells.width = 7.2;
        cells.height = 15.1;
        break;
      case 3:
        box.width = 39;
        break;
      case 4:
        box.height = 47;
        break;
      case 5:
        box.width = 7;
        break;
      case 6:
        box.height = 15;
        break;
      case 7:
        box.left = 42.5;
        box.top = -3.25;
        break;
      case 8:
        box.scaleX = 2;
        box.scaleY = 3;
        break;
      case 9:
        cells.width = Number.NaN;
        break;
      case 10:
        box.left = Infinity;
        break;
      case 11:
        revision = 0;
        break;
      case 12:
        box.scaleY = -1;
        break;
      case 13:
        cells.width = 1;
        cells.height = 1;
        box.width = 2048;
        box.height = 1;
        break;
      case 14:
        cells.width = 1;
        cells.height = 1;
        box.width = 1024;
        box.height = 100;
        break;
    }
    const result = makeDomGeometry(revision, "fixture", cells, box);
    if ([5, 6, 9, 10, 11, 12].includes(id)) {
      expect(result).toBeUndefined();
      if (id === 11)
        expect(makeDomGeometry(1.5, "fixture", cells, box)).toBeUndefined();
      return;
    }
    expect(result).toBeDefined();
    if (!result) throw new Error("expected measured geometry");
    expect([result.columns, result.rows]).toEqual(
      id === 13 ? [1024, 1] : id === 14 ? [1024, 64] : [4, 2],
    );
    expect([result.cellWidth, result.cellHeight]).toEqual(
      id >= 13 && id <= 14 ? [1, 1] : [8, 16],
    );
    expect(result.bounded).toBe(id === 13 || id === 14);
    expect(result.content).toEqual(box);
    if (id === 15) {
      box.width = 99;
      expect(result.content.width).toBe(32);
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.content)).toBe(true);
    }
  });
}

const metrics: PointerGeometryMetrics = {
  rect: { left: 10, top: 20 },
  cellWidth: 8,
  cellHeight: 16,
  columns: 4,
  rows: 2,
};
const event = (clientX: number, clientY: number) =>
  ({ clientX, clientY }) as MouseEvent;
const region = (
  offset: [number, number],
  content: [number, number] = [8, 8],
): WebHostScrollRegion => ({
  id: "fixture-scroll",
  rect: [0, 0, 4, 2],
  offset,
  content,
});

for (let id = 16; id <= 30; id++) {
  test(`w1s${String(id).padStart(3, "0")} pointer geometry contract`, () => {
    switch (id) {
      case 16:
        expect(cellLocationForEvent(event(22, 28), metrics)).toEqual({
          x: 1.5,
          y: 0.5,
        });
        break;
      case 17:
        expect(cellLocationForEvent(event(9.99, 28), metrics)).toBeUndefined();
        break;
      case 18:
        expect(cellLocationForEvent(event(22, 52), metrics)).toBeUndefined();
        break;
      case 19:
        expect(cellLocationForEvent(event(42, 28), metrics)).toBeUndefined();
        break;
      case 20:
        expect(cellLocationForEvent(event(41, 51), metrics)).toEqual({
          x: 3.875,
          y: 1.9375,
        });
        break;
      case 21:
        expect(rawCellLocationForEvent(event(2, 68), metrics)).toEqual({
          x: -1,
          y: 3,
        });
        break;
      case 22:
        expect(
          rawCellLocationForEvent(event(22, 28), {
            ...metrics,
            rect: undefined,
          }),
        ).toBeUndefined();
        break;
      case 23:
        expect(
          linkTargetAt([[1, [[1, 2, 0]]]], ["fixture:one"], { x: 1.5, y: 1.2 }),
        ).toBe("fixture:one");
        break;
      case 24:
        expect(
          linkTargetAt([[1, [[1, 2, 0]]]], ["fixture:one"], { x: 3, y: 1 }),
        ).toBeUndefined();
        break;
      case 25:
        expect(
          linkTargetAt([[1, [[1, 2, 0]]]], ["fixture:one"], { x: 1, y: 0 }),
        ).toBeUndefined();
        break;
      case 26:
        expect(
          wheelTargetCanScroll(
            [region([0, 6]), region([0, 1])],
            { x: 1, y: 1 },
            0,
            1,
          ),
        ).toBe(true);
        break;
      case 27:
        expect(
          wheelTargetCanScroll([region([0, 0])], { x: 1, y: 1 }, 0, -1),
        ).toBe(false);
        break;
      case 28:
        expect(
          wheelTargetCanScroll([region([0, 6])], { x: 1, y: 1 }, 0, 1),
        ).toBe(false);
        break;
      case 29:
        expect(
          wheelTargetCanScroll([region([0, 6])], { x: 1, y: 1 }, 1, 1),
        ).toBe(true);
        break;
      case 30:
        expect(
          wheelTargetCanScroll([region([0, 99])], { x: 1, y: 1 }, 0, 1),
        ).toBe(false);
        expect(
          wheelTargetCanScroll([region([0, -3])], { x: 1, y: 1 }, 0, -1),
        ).toBe(false);
        expect(
          wheelTargetCanScroll([region([0, 99])], { x: 1, y: 1 }, 0, -1),
        ).toBe(true);
        break;
    }
  });
}
