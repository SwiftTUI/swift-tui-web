import { expect, test } from "bun:test";
import { type DomContentBox, makeDomGeometry } from "./DomGeometry.ts";

const content: DomContentBox = {
  width: 320.75,
  height: 200.25,
  left: 12.5,
  top: 9.25,
  offsetX: 3.5,
  offsetY: 2.25,
  scaleX: 1.25,
  scaleY: 1.5,
};
const cells = {
  width: 9.6,
  height: 23.25,
  advance: 9.6,
  baseline: 17.5,
  fontSize: 16,
};
test("integral cell allocation retains fractional content and independent client scales", () => {
  const value = makeDomGeometry(4, "font bytes v1", cells, content)!;
  expect(value.cellWidth).toBe(10);
  expect(value.cellHeight).toBe(24);
  expect(value.columns).toBe(32);
  expect(value.rows).toBe(8);
  expect(value.content).toEqual(content);
  expect(Object.isFrozen(value)).toBe(true);
  expect(Object.isFrozen(value.content)).toBe(true);
});
test("hidden, sub-cell and invalid mounts defer rather than inventing geometry", () => {
  for (const width of [0, -1, 9, Number.NaN, Infinity])
    expect(
      makeDomGeometry(1, "font", cells, { ...content, width }),
    ).toBeUndefined();
  expect(
    makeDomGeometry(1, "font", cells, { ...content, scaleY: 0 }),
  ).toBeUndefined();
});
test("oversize viewport admission bounds both axes and total cells", () => {
  const value = makeDomGeometry(1, "font", cells, {
    ...content,
    width: 50000,
    height: 50000,
  })!;
  expect(value.bounded).toBe(true);
  expect(value.columns).toBe(1024);
  expect(value.rows).toBe(64);
});
