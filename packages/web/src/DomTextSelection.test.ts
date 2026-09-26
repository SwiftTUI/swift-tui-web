import { expect, test } from "bun:test";
import { DomTextSelection } from "./DomTextSelection.ts";
import type { WebHostSurfaceFrame } from "./WebHostSurfaceTransport.ts";

test("structural groups and editable fields select, controls and link runs do not", () => {
  const frame: WebHostSurfaceFrame = {
    version: 2,
    width: 30,
    height: 2,
    styles: [],
    rows: [],
    accessibilityTree: [
      { id: "group", role: "group", rect: [0, 0, 30, 2] },
      { id: "button", role: "button", rect: [5, 0, 6, 1], isEnabled: false },
      { id: "hidden", role: "button", rect: [0, 0, 4, 1], hidden: true },
      {
        id: "field",
        role: "textField",
        rect: [0, 1, 10, 1],
        actions: ["setValue"],
      },
      {
        id: "custom",
        role: "custom(control)",
        rect: [12, 1, 4, 1],
        actions: ["activate"],
      },
      { id: "secure", role: "secureField", rect: [20, 1, 4, 1] },
    ],
    links: [[0, [[20, 4, 0]]]],
    linkTargets: ["https://example.com"],
  };
  const selection = new DomTextSelection(frame);
  expect(selection.allows(0, 0, 5)).toBe(true);
  expect(selection.allows(0, 5, 6)).toBe(false);
  expect(selection.allows(0, 11, 5)).toBe(true);
  expect(selection.allows(0, 20)).toBe(false);
  expect(selection.allows(1, 0, 10)).toBe(true);
  expect(selection.isTextInput(1.5, 3.2)).toBe(true);
  expect(selection.allows(1, 12)).toBe(false);
  expect(selection.allows(1, 20)).toBe(false);
  expect(selection.split(0, [0, "AlphaButtonOmega", 16, 0])).toEqual([
    [0, "Alpha", 5, 0],
    [5, "Button", 6, 0],
    [11, "Omega", 5, 0],
  ]);
});

test("partial control overlap never splits Unicode clusters or enables part of them", () => {
  const selection = new DomTextSelection({
    version: 2,
    width: 4,
    height: 1,
    styles: [],
    rows: [],
    accessibilityTree: [{ id: "button", role: "button", rect: [1, 0, 1, 1] }],
  });
  expect(selection.split(0, [0, "👩‍💻", 2, 0])).toEqual([[0, "👩‍💻", 2, 0]]);
  expect(selection.allows(0, 0, 2)).toBe(false);
});
