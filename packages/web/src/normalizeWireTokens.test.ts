import { expect, test } from "bun:test";

import {
  normalizeLiveRegion,
  normalizePoliteness,
  normalizeScalingMode,
  normalizeSemantics,
} from "./normalizeWireTokens.ts";

test("wire token normalizers preserve every frozen token", () => {
  expect(["none", "automatic", "activate", "edit"].map(normalizeSemantics))
    .toEqual(["none", "automatic", "activate", "edit"]);
  expect(["off", "polite", "assertive"].map(normalizePoliteness))
    .toEqual(["off", "polite", "assertive"]);
  expect(["off", "polite", "assertive"].map(normalizeLiveRegion))
    .toEqual(["off", "polite", "assertive"]);
  expect(["stretch", "fit", "fill"].map(normalizeScalingMode))
    .toEqual(["stretch", "fit", "fill"]);
});

test("wire token normalizers apply the open-world defaults", () => {
  expect(normalizeSemantics("future-focus")).toBe("automatic");
  expect(normalizePoliteness("future-politeness")).toBe("polite");
  expect(normalizeLiveRegion("future-live")).toBeUndefined();
  expect(normalizeLiveRegion(undefined)).toBeUndefined();
  expect(normalizeScalingMode("future-scaling")).toBe("fit");
});
