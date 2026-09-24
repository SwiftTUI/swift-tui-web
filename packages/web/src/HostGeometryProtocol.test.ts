import { expect, test } from "bun:test";
import corpus from "../../../Fixtures/Transport/web-geometry-revisions.json";
import { encodeGeometryControlMessage } from "./HostGeometryProtocol.ts";
import {
  encodeMouseInputMessage,
  WebHostOutputDecoder,
} from "./WebHostSurfaceTransport.ts";

test("canonical Swift geometry corpus preserves decoder baselines through rejected layouts and loss", () => {
  const decoder = new WebHostOutputDecoder();
  expect(corpus.producer).toBe("SwiftTUIRuntime.WebSurfaceFrameEncoder");
  for (const entry of corpus.cases) {
    const records = decoder.feed(new TextEncoder().encode(entry.record));
    expect(records.map((record) => record.type)).toEqual([entry.expected]);
    const record = records[0];
    if (record?.type === "surface") {
      expect(record.frame.geometryRevision).toBe(entry.geometryRevision);
      expect(record.frame.rows).toHaveLength(2);
      expect(record.frame.styles).toHaveLength(2);
    }
  }
});

test("geometry controls preserve large safe revisions and fractional pointer coordinates", () => {
  const geometry = {
    revision: Number.MAX_SAFE_INTEGER,
    columns: 120,
    rows: 40,
    cellWidth: 10,
    cellHeight: 24,
  };
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  expect(decode(encodeGeometryControlMessage(geometry))).toBe(
    "\u001egeometry:9007199254740991:120:40:10:24\n",
  );
  expect(
    decode(
      encodeMouseInputMessage(
        { kind: "down", x: 1.25, y: 2.5, button: "primary" },
        geometry.revision,
      ),
    ),
  ).toBe("\u001emouseGeometry:9007199254740991:down:1.25:2.5:primary:0:0:0\n");
  expect(
    decode(encodeMouseInputMessage({ kind: "moved", x: 1.25, y: 2.5 })),
  ).toBe("\u001emouse:moved:1.25:2.5:none:0:0:0\n");
  for (const patch of [
    { revision: 0 },
    { revision: -1 },
    { revision: 1.5 },
    { revision: 2 ** 53 },
    { columns: 0 },
    { columns: 1025 },
    { rows: 1024 },
    { cellWidth: 0 },
    { cellHeight: 8193 },
    { cellWidth: 1.5 },
  ])
    expect(() =>
      encodeGeometryControlMessage({ ...geometry, ...patch }),
    ).toThrow(RangeError);
});

test("geometry echoes survive full, delta, style append and transport epoch resets", () => {
  const decoder = new WebHostOutputDecoder();
  const frames = [
    {
      version: 2,
      epoch: 1,
      gen: 1,
      geometryRevision: 0,
      width: 1,
      height: 1,
      styles: [null],
      rows: [[[0, "a", 1, 0]]],
    },
    {
      version: 3,
      encoding: "delta",
      epoch: 1,
      gen: 2,
      baselineGen: 1,
      geometryRevision: 7,
      width: 1,
      height: 1,
      styles: [],
      stylesBase: 1,
      deltaRows: [],
    },
    // A late old layout still must decode, so the presenter can reject it
    // without corrupting the transport baseline used by the following delta.
    {
      version: 3,
      encoding: "delta",
      epoch: 1,
      gen: 3,
      baselineGen: 2,
      geometryRevision: 6,
      width: 1,
      height: 1,
      styles: [],
      stylesBase: 1,
      deltaRows: [],
    },
    {
      version: 2,
      epoch: 2,
      gen: 1,
      geometryRevision: Number.MAX_SAFE_INTEGER,
      width: 1,
      height: 1,
      styles: [null],
      rows: [[[0, "b", 1, 0]]],
    },
  ];
  const records = decoder.feed(
    new TextEncoder().encode(
      frames
        .map((frame) => `\u001esurface:${JSON.stringify(frame)}\n`)
        .join(""),
    ),
  );
  expect(
    records.map((record) =>
      record.type === "surface" ? record.frame.geometryRevision : record.type,
    ),
  ).toEqual([0, 7, 6, Number.MAX_SAFE_INTEGER]);
});

test("invalid geometry echoes are rejected without inventing a fallback revision", () => {
  for (const geometryRevision of [-1, 0.5, 2 ** 53, "7", null]) {
    const decoder = new WebHostOutputDecoder();
    const records = decoder.feed(
      new TextEncoder().encode(
        `\u001esurface:${JSON.stringify({ version: 2, width: 1, height: 1, styles: [null], rows: [[]], geometryRevision })}\n`,
      ),
    );
    expect(records.some((record) => record.type === "surface")).toBe(false);
  }
});
