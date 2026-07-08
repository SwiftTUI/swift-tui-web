import { expect, test } from "bun:test";

import { linkTargetAt } from "./PointerGeometry.ts";
import type { WebHostSurfaceLinkRow } from "./WebHostSurfaceTransport.ts";

const links: WebHostSurfaceLinkRow[] = [
  [0, [[0, 2, 0], [3, 1, 1]]],
  [2, [[1, 2, 0]]],
];
const targets = ["https://a.example/docs", "https://b.example"];

test("linkTargetAt resolves runs through the deduplicated target table", () => {
  expect(linkTargetAt(links, targets, { x: 0.2, y: 0.9 })).toBe("https://a.example/docs");
  expect(linkTargetAt(links, targets, { x: 1.9, y: 0 })).toBe("https://a.example/docs");
  expect(linkTargetAt(links, targets, { x: 3.5, y: 0.5 })).toBe("https://b.example");
  expect(linkTargetAt(links, targets, { x: 1, y: 2 })).toBe("https://a.example/docs");
});

test("linkTargetAt returns undefined off the runs", () => {
  expect(linkTargetAt(links, targets, { x: 2.5, y: 0 })).toBeUndefined();
  expect(linkTargetAt(links, targets, { x: 0, y: 1 })).toBeUndefined();
  expect(linkTargetAt(links, targets, { x: 0.5, y: 2.5 })).toBeUndefined();
});

test("linkTargetAt tolerates missing link tables", () => {
  expect(linkTargetAt(undefined, targets, { x: 0, y: 0 })).toBeUndefined();
  expect(linkTargetAt(links, undefined, { x: 0, y: 0 })).toBeUndefined();
  expect(linkTargetAt(links, [], { x: 0, y: 0 })).toBeUndefined();
});
