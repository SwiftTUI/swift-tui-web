import { expect, test } from "bun:test";
import fixture from "../../../Fixtures/Transport/wire-budget-boundaries.json";
import { HOST_WIRE_MAX_RECORD_BYTES, fitsWireGrid } from "./HostWireBudget.ts";
import { WebHostOutputDecoder } from "./WebHostSurfaceTransport.ts";

const encoder = new TextEncoder();
const prefix = "\u001esurface:";
const base = () => ({ version: 2, epoch: 7, gen: 1, width: 1, height: 2,
  styles: [null], rows: [[[0, "a", 1, 0]], []] });
const wire = (frame: unknown) => prefix + JSON.stringify(frame) + "\n";

function padded(bytes: number): string {
  // Non-ASCII content distinguishes UTF-8 bytes from JS/Kotlin string lengths.
  return "é".repeat(Math.floor(bytes / 2)) + "x".repeat(bytes % 2);
}

for (const entry of fixture.cases) {
  test(`shared wire boundary ${entry.kind} ${entry.value ?? entry.width}`, () => {
    const frame: Record<string, unknown> = base();
    const value = entry.value!;
    switch (entry.kind) {
      case "recordBytes": frame.future = padded(value - encoder.encode(wire({ ...frame, future: "" })).length + 1); break;
      case "width": frame.width = value; break;
      case "grid": frame.width = entry.width; frame.height = entry.height; break;
      case "cellTextBytes": frame.rows = [[[0, padded(value), 1, 0]], []]; break;
      case "styleBytes": frame.styles = [{ future: padded(value - 22) }]; break;
      case "styles": frame.styles = Array(value).fill(null); break;
      case "images": frame.images = Array.from({ length: value }, () => ({ id: "i", format: "future",
        bounds: [0, 0, 0, 0], visibleBounds: [0, 0, 0, 0], scalingMode: "stretch" })); break;
      case "rows": frame.rows = Array.from({ length: value }, () => []); break;
      case "metadataEntries": frame.linkTargets = Array(value).fill(""); break;
      case "imageDimension": case "imagePixels": case "imageIdBytes":
        frame.images = [{ id: entry.kind === "imageIdBytes" ? padded(value) : "i", format: "future",
          bounds: [0, 0, 0, 0], visibleBounds: [0, 0, 0, 0], scalingMode: "stretch",
          pixelSize: entry.kind === "imagePixels" ? [entry.width, entry.height]
            : entry.kind === "imageDimension" ? [value, 1] : [1, 1] }];
        break;
      case "deltaRow":
        delete frame.rows;
        Object.assign(frame, { version: 3, encoding: "delta", gen: 2, baselineGen: 1, deltaRows: [[value, []]] });
        break;
    }
    let record = wire(frame);
    if (entry.kind === "jsonDepth") {
      record = record.slice(0, -2) + ',"future":' + "[".repeat(value - 1) + "0"
        + "]".repeat(value - 1) + "}\n";
    }
    const decoder = new WebHostOutputDecoder();
    decoder.feed(encoder.encode(wire(base())));
    const records = decoder.feed(encoder.encode(record));
    expect(records[0]?.type === "surface").toBe(entry.accepted);
    if (!entry.accepted) {
      expect(records).toEqual([{ type: "surfaceDropped", reason: "budgetExceeded" }]);
      expect(decoder.takeResyncRequest()).toEqual({ scope: "keyframe" });
      expect(decoder.takeResyncRequest()).toBeUndefined();
      expect(decoder.feed(encoder.encode(wire(base())))[0]?.type).toBe("surface");
    }
  });
}

test("unterminated records stay bounded, discard through LF and recover without a request storm", () => {
  const decoder = new WebHostOutputDecoder();
  decoder.feed(encoder.encode(wire(base())));
  expect(decoder.feed(encoder.encode(prefix))).toEqual([]);
  const block = new Uint8Array(8192).fill(120);
  let refused = 0;
  for (let i = 0; i < 1024; i++) refused += decoder.feed(block).length;
  expect(refused).toBe(1);
  expect(decoder.takeResyncRequest()).toEqual({ scope: "keyframe" });
  expect(decoder.takeResyncRequest()).toBeUndefined();
  const recovered = decoder.feed(encoder.encode(wire(base()) + wire(base())));
  expect(recovered.map(record => record.type)).toEqual(["surface"]);
});

test("byte-at-a-time framing preserves UTF-8 and exact record boundary decisions", () => {
  const record = wire({ ...base(), rows: [[[0, "👩🏽‍💻", 1, 0]], []] });
  const decoder = new WebHostOutputDecoder();
  const result = [...encoder.encode(record)].flatMap(byte => decoder.feed(Uint8Array.of(byte)));
  expect(result).toEqual(new WebHostOutputDecoder().feed(encoder.encode(record)));
  const oversized = encoder.encode(prefix + "x".repeat(HOST_WIRE_MAX_RECORD_BYTES));
  const fragmented = new WebHostOutputDecoder();
  expect(fragmented.feed(oversized.subarray(0, HOST_WIRE_MAX_RECORD_BYTES))).toEqual([]);
  expect(fragmented.feed(oversized.subarray(HOST_WIRE_MAX_RECORD_BYTES)).map(record => record.type))
    .toEqual(["surfaceDropped"]);
  expect(fragmented.flush()).toEqual([]);
  expect(fragmented.feed(encoder.encode(wire(base())))[0]?.type).toBe("surface");
});

test("style append and invalid deltas cannot grow or replace the retained baseline", () => {
  const decoder = new WebHostOutputDecoder();
  decoder.feed(encoder.encode(wire({ ...base(), styles: Array(1024).fill(null) })));
  const delta = { version: 3, encoding: "delta", epoch: 7, gen: 2, baselineGen: 1,
    width: 1, height: 2, stylesBase: 1024, styles: [null], deltaRows: [] };
  expect(decoder.feed(encoder.encode(wire(delta)))[0]?.type).toBe("surfaceDropped");
  // Inspect the same baseline using an empty valid append (no new table allocation).
  expect(decoder.feed(encoder.encode(wire({ ...delta, styles: [] })))[0]?.type).toBe("surface");
  for (const rows of [[[2, []]], [[0, []], [0, []]], [[0, [[0, "x", 2147483647, 0]]]]]) {
    expect(decoder.feed(encoder.encode(wire({ ...delta, stylesBase: undefined, styles: [null], deltaRows: rows })))[0]?.type)
      .toBe("surfaceDropped");
  }
  expect(decoder.feed(encoder.encode(wire(base())))[0]?.type).toBe("surface");
});

test("a dense 256 by 256 grid stays supported", () => {
  expect(fitsWireGrid(256, 256)).toBe(true);
  const frame = { ...base(), width: 256, height: 256,
    rows: Array.from({ length: 256 }, () => Array.from({ length: 256 }, (_, x) => [x, "a", 1, 0])) };
  expect(new WebHostOutputDecoder().feed(encoder.encode(wire(frame)))[0]?.type).toBe("surface");
});
