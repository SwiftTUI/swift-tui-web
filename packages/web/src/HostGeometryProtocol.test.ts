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

test("paragraph spacing is an optional bounded geometry extension", () => {
  const geometry = {
    revision: 2,
    columns: 32,
    rows: 16,
    cellWidth: 10,
    cellHeight: 24,
  };
  for (const spacing of [0, 2, 8192]) {
    expect(
      new TextDecoder().decode(
        encodeGeometryControlMessage({
          ...geometry,
          paragraphSpacing: spacing,
        }),
      ),
    ).toBe(`\u001egeometry:2:32:16:10:24:${spacing}\n`);
  }
  for (const paragraphSpacing of [-1, 0.5, 8193, Infinity])
    expect(() =>
      encodeGeometryControlMessage({ ...geometry, paragraphSpacing }),
    ).toThrow(RangeError);
});

test("paragraph metadata is a complete snapshot in full and delta frames", () => {
  const decoder = new WebHostOutputDecoder();
  const frame = {
    version: 2,
    epoch: 1,
    gen: 1,
    width: 3,
    height: 1,
    styles: [null],
    rows: [[[0, "abc", 3, 0]]],
    paragraphs: [{ id: "p", rect: [0, 0, 3, 1] }],
  };
  // Match the production record delimiter used by the existing geometry corpus.
  const prefix = corpus.cases[0]!.record.slice(
    0,
    corpus.cases[0]!.record.indexOf("{"),
  );
  const read = (value: unknown) =>
    decoder.feed(
      new TextEncoder().encode(`${prefix}${JSON.stringify(value)}\n`),
    );
  const initial = read(frame)[0];
  expect(initial?.type).toBe("surface");
  if (initial?.type === "surface")
    expect(initial.frame.paragraphs).toEqual(frame.paragraphs);
  const next = read({
    version: 3,
    encoding: "delta",
    epoch: 1,
    gen: 2,
    baselineGen: 1,
    width: 3,
    height: 1,
    styles: [null],
    deltaRows: [],
  })[0];
  expect(next?.type).toBe("surface");
  if (next?.type === "surface") expect(next.frame.paragraphs).toBeUndefined();
  for (const rect of [
    [-1, 0, 3, 1],
    [0, 0, 4, 1],
    [0, 0, 0, 1],
  ])
    expect(
      read({ ...frame, gen: 3, paragraphs: [{ id: "p", rect }] })[0]?.type,
    ).not.toBe("surface");
});

test("shared viewport mouse records preserve Canvas zero and independent DOM geometry revisions", () => {
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  for (const revision of [0, 3]) {
    expect(
      decode(
        encodeMouseInputMessage(
          { kind: "down", x: 1.5, y: 2, button: "primary" },
          revision,
          4,
        ),
      ),
    ).toBe(`\u001emouseViewport:${revision}:4:down:1.5:2:primary:0:0:0\n`);
  }
  for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() =>
      encodeMouseInputMessage({ kind: "moved", x: 0, y: 0 }, 0, revision),
    ).toThrow();
  }
});
