import { expect, test } from "bun:test";
import {
  WebHostOutputDecoder,
  type WebHostOutputRecord,
  type WebHostSurfaceFrame,
} from "./WebHostSurfaceTransport.ts";

const full = (fields: Record<string, unknown> = {}): WebHostSurfaceFrame => ({
  version: 2,
  epoch: 1,
  gen: 1,
  width: 4,
  height: 2,
  styles: [null],
  rows: [[[0, "界", 2, 0]], [[0, "b", 1, 0]]],
  ...fields,
});
const delta = (fields: Record<string, unknown> = {}) => ({
  version: 3,
  encoding: "delta",
  epoch: 1,
  gen: 2,
  baselineGen: 1,
  width: 4,
  height: 2,
  styles: [null],
  deltaRows: [[0, [[0, "z", 1, 0]]]],
  ...fields,
});
const bytes = (value: unknown) =>
  new TextEncoder().encode(`\x1esurface:${JSON.stringify(value)}\n`);
function surface(record: WebHostOutputRecord | undefined): WebHostSurfaceFrame {
  expect(record?.type).toBe("surface");
  if (record?.type !== "surface") throw new Error("fixture expected surface");
  return record.frame;
}

for (let id = 111; id <= 130; id++) {
  test(`w1s${id} decoder transition contract`, () => {
    const decoder = new WebHostOutputDecoder();
    const feed = (value: unknown) => decoder.feed(bytes(value));
    switch (id) {
      case 111:
      case 112: {
        const source =
          id === 111
            ? bytes(full())
            : new Uint8Array([...bytes(full()), ...bytes(full({ gen: 2 }))]);
        const expected = new WebHostOutputDecoder().feed(source);
        for (let split = 0; split <= source.length; split++) {
          const candidate = new WebHostOutputDecoder();
          expect([
            ...candidate.feed(source.subarray(0, split)),
            ...candidate.feed(source.subarray(split)),
            ...candidate.flush(),
          ]).toEqual(expected);
        }
        break;
      }
      case 113: {
        const source = bytes(full());
        expect(decoder.feed(source.subarray(0, -1))).toEqual([]);
        expect(surface(decoder.flush()[0]).rows).toEqual(full().rows);
        expect(decoder.flush()).toEqual([]);
        break;
      }
      case 114:
        expect(decoder.flush()).toEqual([]);
        expect(decoder.flush()).toEqual([]);
        break;
      case 115: {
        const source = new Uint8Array([
          ...bytes(full()),
          ...new TextEncoder().encode("ordinary text\n"),
          ...bytes(full({ gen: 2 })),
        ]);
        const result = decoder.feed(source);
        expect(result.map((r) => r.type)).toEqual([
          "surface",
          "text",
          "surface",
        ]);
        expect(result[1]).toEqual({ type: "text", text: "ordinary text\n" });
        break;
      }
      case 116:
        expect(
          decoder.feed(
            new TextEncoder().encode('\x1eclipboard:{"text":"a\\nb"}\n'),
          ),
        ).toEqual([{ type: "clipboard", text: "a\nb" }]);
        break;
      case 117:
        expect(
          decoder.feed(new TextEncoder().encode("\x1eunknown:{}\n")),
        ).toEqual([{ type: "text", text: "\x1eunknown:{}\n" }]);
        break;
      case 118:
        expect(
          decoder.feed(new TextEncoder().encode("\x1esurface:{oops}\n"))[0]
            ?.type,
        ).toBe("text");
        expect(surface(feed(full())[0]).gen).toBe(1);
        break;
      case 119:
        expect(feed(full({ version: 4 }))[0]).toMatchObject({
          type: "runtimeIssue",
          issue: { code: "surface.unsupportedVersion" },
        });
        break;
      case 120:
        expect(feed(delta())[0]).toEqual({
          type: "surfaceDropped",
          reason: "noBaseline",
        });
        expect(decoder.takeResyncRequest()).toBeDefined();
        expect(decoder.takeResyncRequest()).toBeUndefined();
        break;
      case 121:
        feed(full({ rows: [[]] }));
        expect(
          surface(feed(delta({ deltaRows: [[1, [[0, "z", 1, 0]]]] }))[0])
            .rows[1],
        ).toEqual([[0, "z", 1, 0]]);
        break;
      case 122:
        feed(full());
        expect(
          surface(feed(delta({ deltaRows: [[0, []]] }))[0]).rows[0],
        ).toEqual([]);
        break;
      case 123:
        feed(full());
        expect(surface(feed(delta())[0]).rows[1]).toEqual([[0, "b", 1, 0]]);
        break;
      case 124: {
        feed(full());
        const appended = { em: 1 };
        const result = surface(
          feed(
            delta({
              stylesBase: 1,
              styles: [appended],
              deltaRows: [[0, [[0, "z", 1, 1]]]],
            }),
          )[0],
        );
        expect(result.styles).toEqual([null, appended]);
        expect(result.rows[0]?.[0]?.[3]).toBe(1);
        break;
      }
      case 125:
        feed(full());
        feed(delta({ stylesBase: 2, styles: [] }));
        expect(decoder.takeResyncRequest()).toBeDefined();
        expect(surface(feed(delta())[0]).gen).toBe(2);
        break;
      case 126:
        feed(full());
        expect(feed(delta({ baselineGen: 0 }))[0]).toEqual({
          type: "surfaceDropped",
          reason: "staleBaseline",
        });
        expect(surface(feed(delta())[0]).gen).toBe(2);
        break;
      case 127:
        feed(full());
        expect(feed(delta({ epoch: 2 }))[0]).toEqual({
          type: "surfaceDropped",
          reason: "staleBaseline",
        });
        expect(surface(feed(full({ epoch: 2 }))[0]).epoch).toBe(2);
        break;
      case 128:
        feed(full({ links: [[0, [[0, 1, 0]]]], linkTargets: ["fixture:one"] }));
        expect(surface(feed(delta())[0]).links).toBeUndefined();
        break;
      case 129:
        feed(full());
        feed(delta({ baselineGen: 0 }));
        feed(delta({ baselineGen: 0 }));
        expect(decoder.takeResyncRequest()).toBeDefined();
        expect(decoder.takeResyncRequest()).toBeUndefined();
        break;
      case 130:
        feed(full());
        feed(delta({ baselineGen: 0 }));
        expect(decoder.takeResyncRequest()).toBeDefined();
        feed(full({ gen: 4 }));
        feed(delta({ baselineGen: 0 }));
        expect(decoder.takeResyncRequest()).toBeDefined();
        break;
    }
  });
}
