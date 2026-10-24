import { expect, test } from "bun:test";
import {
  fitsJSONDepth,
  fitsStyleContent,
  fitsSurfaceBudget,
  fitsUTF8,
  fitsWireGrid,
} from "./HostWireBudget.ts";

type BudgetFrame = Parameters<typeof fitsSurfaceBudget>[0];
const frame = (overrides: Partial<BudgetFrame> = {}): BudgetFrame => ({
  width: 4,
  height: 2,
  styles: [null],
  rows: [[], []],
  ...overrides,
});

for (let id = 91; id <= 110; id++) {
  test(`w1s${String(id).padStart(3, "0")} bounded frame admission contract`, () => {
    switch (id) {
      case 91:
      case 92:
        for (const sample of id === 91
          ? ["abc", "界", "😀", "e\u0301", "a界😀"]
          : ["\ud800", "\udc00"]) {
          const count = new TextEncoder().encode(sample).length;
          expect(fitsUTF8(sample, count)).toBe(true);
          expect(fitsUTF8(sample, count - 1)).toBe(false);
        }
        break;
      case 93:
        expect(fitsWireGrid(0, 4)).toBe(true);
        expect(fitsWireGrid(4, 0)).toBe(true);
        break;
      case 94:
        expect(fitsWireGrid(1.5, 2)).toBe(false);
        expect(fitsWireGrid(2, 1.5)).toBe(false);
        break;
      case 95:
        expect(fitsWireGrid(1024, 64)).toBe(true);
        expect(fitsWireGrid(1024, 65)).toBe(false);
        break;
      case 96:
        expect(fitsStyleContent(null)).toBe(true);
        break;
      case 97:
        // 3 JSON values * 8 + keys "font" and "family" (10) = 34 units.
        expect(fitsStyleContent({ font: { family: "a".repeat(990) } })).toBe(
          true,
        );
        expect(fitsStyleContent({ font: { family: "a".repeat(991) } })).toBe(
          false,
        );
        break;
      case 98:
        expect(
          fitsJSONDepth(
            JSON.stringify({ text: '[{"quoted":"\\""}]'.repeat(3) }),
          ),
        ).toBe(true);
        break;
      case 99:
        expect(fitsSurfaceBudget(frame({ rows: [[[0, "a", 1, 0]]] }))).toBe(
          true,
        );
        break;
      case 100:
        expect(
          fitsSurfaceBudget(
            frame({
              rows: [
                [
                  [0, "界", 2, 0],
                  [1, "a", 1, 0],
                ],
              ],
            }),
          ),
        ).toBe(false);
        break;
      case 101:
        expect(fitsSurfaceBudget(frame({ rows: [[[2, "界", 2, 0]]] }))).toBe(
          true,
        );
        break;
      case 102:
        expect(fitsSurfaceBudget(frame({ rows: [[[3, "界", 2, 0]]] }))).toBe(
          false,
        );
        break;
      case 103:
        expect(fitsSurfaceBudget(frame({ rows: [[[0, "a", 1, 1]]] }))).toBe(
          false,
        );
        break;
      case 104:
        expect(
          fitsSurfaceBudget(frame({ stylesBase: 2, rows: [[[0, "a", 1, 2]]] })),
        ).toBe(true);
        break;
      case 105:
        expect(
          fitsSurfaceBudget(
            frame({
              deltaRows: [
                [0, []],
                [0, []],
              ],
            }),
          ),
        ).toBe(false);
        break;
      case 106:
      case 107:
        expect(
          fitsSurfaceBudget(
            frame({
              paragraphs: [
                { id: "first", rect: [0, 0, 2, 1] },
                { id: "second", rect: [id === 106 ? 2 : 1, 0, 2, 1] },
              ],
            }),
          ),
        ).toBe(id === 106);
        break;
      case 108:
        expect(
          fitsSurfaceBudget(
            frame({ paragraphs: [{ id: "one", rect: [3, 0, 2, 1] }] }),
          ),
        ).toBe(false);
        break;
      case 109:
        expect(
          fitsSurfaceBudget(
            frame({
              links: [
                [
                  0,
                  [
                    [0, 2, 0],
                    [1, 2, 0],
                  ],
                ],
              ],
              linkTargets: ["fixture:one"],
            }),
          ),
        ).toBe(false);
        break;
      case 110:
        expect(
          fitsSurfaceBudget(
            frame({
              damage: {
                textRows: [
                  [
                    0,
                    [
                      [0, 2],
                      [1, 3],
                    ],
                  ],
                ],
              },
            }),
          ),
        ).toBe(true);
        break;
    }
  });
}
