import { expect, test } from "bun:test";

import {
  SUPPORTED_SURFACE_VERSION,
  WebHostOutputDecoder,
  encodeCapabilitiesControlMessage,
  encodeMouseInputMessage,
  type WebHostOutputRecord,
  type WebHostSurfaceFrame,
} from "./WebHostSurfaceTransport.ts";
import { transportFixture } from "./WebHostTestFixtures.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

test("decoder reads shared web-surface fixtures across chunk boundaries", () => {
  const decoder = new WebHostOutputDecoder();
  const fixture = transportFixture("web-surface-basic");
  const split = Math.floor(fixture.length / 2);

  expect(decoder.feed(encoder.encode(fixture.slice(0, split)))).toEqual([]);

  const records = decoder.feed(encoder.encode(fixture.slice(split)));
  expect(records).toHaveLength(1);
  expect(records[0]?.type).toBe("surface");

  const frame = surfaceFrame(records[0]);
  expect(frame.width).toBe(2);
  expect(frame.height).toBe(2);
  expect(frame.styles).toEqual([null]);
  expect(frame.rows[0]).toEqual([[0, "O", 1, 0], [1, "K", 1, 0]]);
});

test("decoder returns multiple records from one stdout chunk", () => {
  const decoder = new WebHostOutputDecoder();
  const records = decoder.feed(
    encoder.encode(
      transportFixture("web-surface-basic")
        + "legacy text\n"
        + transportFixture("web-surface-styled")
    )
  );

  expect(records.map((record) => record.type)).toEqual(["surface", "text", "surface"]);
  expect(records[1]).toEqual({ type: "text", text: "legacy text\n" });
  expect(surfaceFrame(records[2]).styles).toHaveLength(4);
});

test("decoder preserves typed image records", () => {
  const decoder = new WebHostOutputDecoder();
  const records = decoder.feed(encoder.encode(
    '\u001Esurface:{"version":1,"width":2,"height":1,"styles":[null],"rows":[[]],'
      + '"images":[{"id":"png:test","format":"png","bounds":[0,0,1,1],'
      + '"visibleBounds":[0,0,1,1],"scalingMode":"stretch","pixelSize":[1,1],'
      + '"dataBase64":"iVBORw=="}]}\n'
  ));

  const frame = surfaceFrame(records[0]);
  expect(frame.images).toEqual([
    {
      id: "png:test",
      format: "png",
      bounds: [0, 0, 1, 1],
      visibleBounds: [0, 0, 1, 1],
      scalingMode: "stretch",
      pixelSize: [1, 1],
      dataBase64: "iVBORw==",
    },
  ]);
});

test("decoder preserves presentation damage records", () => {
  const decoder = new WebHostOutputDecoder();
  const records = decoder.feed(encoder.encode(
    '\u001Esurface:{"version":1,"width":2,"height":2,"styles":[null],"rows":[[],[]],'
      + '"images":[],"damage":{"textRows":[[1,[[0,2]]]],'
      + '"requiresFullTextRepaint":false,"requiresFullGraphicsReplay":false}}\n'
  ));

  const frame = surfaceFrame(records[0]);
  expect(frame.damage).toEqual({
    textRows: [[1, [[0, 2]]]],
    requiresFullTextRepaint: false,
    requiresFullGraphicsReplay: false,
  });
});

test("decoder accepts v2 accessibility trees", () => {
  const decoder = new WebHostOutputDecoder();
  const records = decoder.feed(encoder.encode(
    '\u001Esurface:{"version":2,"sequence":9,"width":2,"height":1,'
      + '"styles":[null],"rows":[[]],'
      + '"accessibilityTree":[{"id":"root/button","parentId":"root","rect":[0,0,2,1],'
      + '"role":"button","label":"Save","hint":"Writes the file",'
      + '"cursorAnchor":[1,0],"isFocused":true},'
      + '{"id":"root/status","rect":[0,1,2,1],"role":"status","label":"Saved",'
      + '"liveRegion":"polite","isFocused":false}]}\n'
  ));

  const frame = surfaceFrame(records[0]);
  expect(frame.version).toBe(2);
  expect(frame.sequence).toBe(9);
  expect(frame.accessibilityTree).toEqual([
    {
      id: "root/button",
      parentId: "root",
      rect: [0, 0, 2, 1],
      role: "button",
      label: "Save",
      hint: "Writes the file",
      cursorAnchor: [1, 0],
      isFocused: true,
    },
    {
      id: "root/status",
      rect: [0, 1, 2, 1],
      role: "status",
      label: "Saved",
      liveRegion: "polite",
      isFocused: false,
    },
  ]);
});

test("decoder accepts imperative accessibility announcements", () => {
  const decoder = new WebHostOutputDecoder();
  const records = decoder.feed(encoder.encode(
    '\u001Esurface:{"version":2,"width":2,"height":1,"styles":[null],"rows":[[]],'
      + '"accessibilityAnnouncements":[{"message":"Saved","politeness":"assertive"},'
      + '{"message":"Queued","politeness":"polite"}]}\n'
  ));

  const frame = surfaceFrame(records[0]);
  expect(frame.accessibilityAnnouncements).toEqual([
    { message: "Saved", politeness: "assertive" },
    { message: "Queued", politeness: "polite" },
  ]);
});

test("decoder rejects malformed accessibility trees as diagnostic text", () => {
  const decoder = new WebHostOutputDecoder();
  const line = '\u001Esurface:{"version":2,"width":2,"height":1,"styles":[null],"rows":[[]],'
    + '"accessibilityTree":[{"id":"missing-rect","role":"button"}]}\n';

  expect(decoder.feed(encoder.encode(line))).toEqual([
    {
      type: "text",
      text: line,
    },
  ]);
});

test("decoder keeps malformed surface output visible as text", () => {
  const decoder = new WebHostOutputDecoder();
  const records = decoder.feed(encoder.encode('\u001Esurface:{"version":1,"width":2}\n'));

  expect(records).toEqual([
    {
      type: "text",
      text: '\u001Esurface:{"version":1,"width":2}\n',
    },
  ]);
});

test("decoder reads typed clipboard records", () => {
  const decoder = new WebHostOutputDecoder();
  const records = decoder.feed(encoder.encode('\u001Eclipboard:{"text":"copy \\"this\\""}\n'));

  expect(records).toEqual([
    {
      type: "clipboard",
      text: 'copy "this"',
    },
  ]);
});

test("decoder reads typed runtime issue records", () => {
  const decoder = new WebHostOutputDecoder();
  const records = decoder.feed(encoder.encode(
    '\u001EruntimeIssue:{"severity":"warning","code":"toolbar.unhostedItems",'
      + '"message":"Toolbar item was not rendered",'
      + '"description":"SwiftTUI runtime warning [toolbar.unhostedItems] Toolbar item was not rendered",'
      + '"identity":"root/body","source":".toolbarItem(...)"}\n'
  ));

  expect(records).toEqual([
    {
      type: "runtimeIssue",
      issue: {
        severity: "warning",
        code: "toolbar.unhostedItems",
        message: "Toolbar item was not rendered",
        description: "SwiftTUI runtime warning [toolbar.unhostedItems] Toolbar item was not rendered",
        identity: "root/body",
        source: ".toolbarItem(...)",
      },
    },
  ]);
});

test("decoder keeps malformed runtime issue records visible as text", () => {
  const decoder = new WebHostOutputDecoder();
  const line = '\u001EruntimeIssue:{"severity":"warning","code":"toolbar.unhostedItems",'
    + '"message":7,'
    + '"description":"SwiftTUI runtime warning [toolbar.unhostedItems] Toolbar item was not rendered"}\n';

  expect(decoder.feed(encoder.encode(line))).toEqual([
    {
      type: "text",
      text: line,
    },
  ]);
});

test("decoder reads typed frame diagnostic records", () => {
  const decoder = new WebHostOutputDecoder();
  const records = decoder.feed(encoder.encode(
    '\u001EframeDiagnostic:{"format":"swift-tui-frame-diagnostics-v1",'
      + '"header":["frame","total_ms"],"fields":["7","14.20"]}\n'
  ));

  expect(records).toEqual([
    {
      type: "frameDiagnostic",
      diagnostic: {
        format: "swift-tui-frame-diagnostics-v1",
        header: ["frame", "total_ms"],
        fields: ["7", "14.20"],
      },
    },
  ]);
});

test("decoder keeps malformed frame diagnostic records visible as text", () => {
  const decoder = new WebHostOutputDecoder();
  const line = '\u001EframeDiagnostic:{"format":"swift-tui-frame-diagnostics-v1",'
    + '"header":["frame"],"fields":[7]}\n';

  expect(decoder.feed(encoder.encode(line))).toEqual([
    {
      type: "text",
      text: line,
    },
  ]);
});

test("decoder materializes delta surface frames from a full baseline", () => {
  const decoder = new WebHostOutputDecoder();
  const records = decoder.feed(encoder.encode(
    '\u001Esurface:{"version":2,"width":2,"height":2,"styles":[null],'
      + '"rows":[[[0,"A",1,0]],[[0,"B",1,0]]],"images":[]}\n'
      + '\u001Esurface:{"version":3,"encoding":"delta","width":2,"height":2,'
      + '"sequence":7,"styles":[null],"deltaRows":[[1,[[0,"C",1,0]]]],"images":[],'
      + '"damage":{"textRows":[[1,[[0,1]]]],'
      + '"requiresFullTextRepaint":false,"requiresFullGraphicsReplay":false}}\n'
  ));

  expect(records.map((record) => record.type)).toEqual(["surface", "surface"]);
  expect(surfaceFrame(records[1])).toEqual({
    version: 2,
    sequence: 7,
    width: 2,
    height: 2,
    styles: [null],
    rows: [
      [[0, "A", 1, 0]],
      [[0, "C", 1, 0]],
    ],
    images: [],
    damage: {
      textRows: [[1, [[0, 1]]]],
      requiresFullTextRepaint: false,
      requiresFullGraphicsReplay: false,
    },
  });
});

test("decoder rebaselines a full frame received after a delta", () => {
  const decoder = new WebHostOutputDecoder();
  const records = decoder.feed(encoder.encode(
    '\u001Esurface:{"version":2,"width":2,"height":1,'
      + '"styles":[null,{"fg":"#FF0000FF"},{"fg":"#0000FFFF"}],'
      + '"rows":[[[0,"A",1,1],[1,"B",1,2]]],"images":[]}\n'
      + '\u001Esurface:{"version":3,"encoding":"delta","width":2,"height":1,'
      + '"sequence":2,"styles":[null,{"fg":"#FF0000FF"},{"fg":"#0000FFFF"}],'
      + '"deltaRows":[[0,[[0,"C",1,2],[1,"D",1,1]]]],"images":[]}\n'
      + '\u001Esurface:{"version":2,"width":2,"height":1,"sequence":3,'
      + '"styles":[null,{"fg":"#0000FFFF"},{"fg":"#FF0000FF"}],'
      + '"rows":[[[0,"E",1,1],[1,"F",1,2]]],"images":[]}\n'
      + '\u001Esurface:{"version":3,"encoding":"delta","width":2,"height":1,'
      + '"sequence":4,"styles":[null,{"fg":"#0000FFFF"},{"fg":"#FF0000FF"}],'
      + '"deltaRows":[[0,[[0,"G",1,2],[1,"H",1,1]]]],"images":[]}\n'
  ));

  expect(records.map((record) => record.type)).toEqual([
    "surface",
    "surface",
    "surface",
    "surface",
  ]);
  expect(surfaceFrame(records[3])).toMatchObject({
    sequence: 4,
    styles: [
      null,
      { fg: "#0000FFFF" },
      { fg: "#FF0000FF" },
    ],
    rows: [[[0, "G", 1, 2], [1, "H", 1, 1]]],
  });
});

test("decoder keeps delta surface output before any full baseline visible as text", () => {
  const decoder = new WebHostOutputDecoder();
  const line = '\u001Esurface:{"version":3,"encoding":"delta","width":2,"height":2,'
    + '"styles":[null],"deltaRows":[[1,[[0,"C",1,0]]]],"images":[]}\n';

  expect(decoder.feed(encoder.encode(line))).toEqual([
    {
      type: "text",
      text: line,
    },
  ]);
});

test("decoder keeps delta surface output with changed dimensions visible as text", () => {
  const decoder = new WebHostOutputDecoder();
  const baseline = '\u001Esurface:{"version":2,"width":2,"height":2,"styles":[null],'
    + '"rows":[[[0,"A",1,0]],[[0,"B",1,0]]]}\n';
  const delta = '\u001Esurface:{"version":3,"encoding":"delta","width":3,"height":2,'
    + '"styles":[null],"deltaRows":[[1,[[0,"C",1,0]]]],"images":[]}\n';

  const records = decoder.feed(encoder.encode(baseline + delta));

  expect(records.map((record) => record.type)).toEqual(["surface", "text"]);
  expect(records[1]).toEqual({ type: "text", text: delta });
});

test("decoder keeps delta surface output with out-of-range row indexes visible as text", () => {
  const decoder = new WebHostOutputDecoder();
  const baseline = '\u001Esurface:{"version":2,"width":2,"height":2,"styles":[null],'
    + '"rows":[[[0,"A",1,0]],[[0,"B",1,0]]]}\n';
  const delta = '\u001Esurface:{"version":3,"encoding":"delta","width":2,"height":2,'
    + '"styles":[null],"deltaRows":[[2,[[0,"C",1,0]]]],"images":[]}\n';

  const records = decoder.feed(encoder.encode(baseline + delta));

  expect(records.map((record) => record.type)).toEqual(["surface", "text"]);
  expect(records[1]).toEqual({ type: "text", text: delta });
});

test("decoder keeps delta surface output with malformed cells visible as text", () => {
  const decoder = new WebHostOutputDecoder();
  const baseline = '\u001Esurface:{"version":2,"width":2,"height":2,"styles":[null],'
    + '"rows":[[[0,"A",1,0]],[[0,"B",1,0]]]}\n';
  const delta = '\u001Esurface:{"version":3,"encoding":"delta","width":2,"height":2,'
    + '"styles":[null],"deltaRows":[[1,[["not-a-cell"],[1,"C",1,"bad-style"]]]],"images":[]}\n';

  const records = decoder.feed(encoder.encode(baseline + delta));

  expect(records.map((record) => record.type)).toEqual(["surface", "text"]);
  expect(records[1]).toEqual({ type: "text", text: delta });
});

test("decoder flushes partial buffered text as diagnostic output", () => {
  const decoder = new WebHostOutputDecoder();

  expect(decoder.feed(encoder.encode("partial diagnostic"))).toEqual([]);
  expect(decoder.flush()).toEqual([
    {
      type: "text",
      text: "partial diagnostic\n",
    },
  ]);
});

test("mouse input encoder preserves fractional cell coordinates", () => {
  expect(decoder.decode(encodeMouseInputMessage({
    kind: "dragged",
    x: 2.125,
    y: 1.75,
    button: "primary",
  }))).toBe("\u001Emouse:dragged:2.125:1.75:primary:0:0:0\n");

  expect(decoder.decode(encodeMouseInputMessage({
    kind: "moved",
    x: -0.25,
    y: 99.5,
  }))).toBe("\u001Emouse:moved:-0.25:99.5:none:0:0:0\n");
});

test("decoder parses hyperlink runs, focus presentation, and preferred grid size", () => {
  const decoder = new WebHostOutputDecoder();
  const records = decoder.feed(encoder.encode(
    "\u001Esurface:" + JSON.stringify({
      version: 2,
      sequence: 9,
      width: 4,
      height: 2,
      styles: [null],
      rows: [[[0, "a", 1, 0], [1, "b", 1, 0]], []],
      links: [[0, [[0, 2, 0], [2, 1, 1]]]],
      linkTargets: ["https://a.example/docs", "https://b.example"],
      focusPresentation: {
        focusedIdentity: "root/field",
        semantics: "edit",
        prefersTextInput: true,
        hasFocusedRegion: true,
      },
      preferredGridWidth: 9,
      preferredGridHeight: 8,
      accessibilityTree: [
        { id: "root", rect: [0, 0, 4, 2], role: "group" },
        { id: "root/ghost", parentId: "root", rect: [0, 0, 1, 1], role: "group", hidden: true },
      ],
    }) + "\n"
  ));

  expect(records).toHaveLength(1);
  const frame = surfaceFrame(records[0]);
  expect(frame.links).toEqual([[0, [[0, 2, 0], [2, 1, 1]]]]);
  expect(frame.linkTargets).toEqual(["https://a.example/docs", "https://b.example"]);
  expect(frame.focusPresentation).toEqual({
    focusedIdentity: "root/field",
    semantics: "edit",
    prefersTextInput: true,
    hasFocusedRegion: true,
  });
  expect(frame.preferredGridWidth).toBe(9);
  expect(frame.preferredGridHeight).toBe(8);
  expect(frame.accessibilityTree?.[1]?.hidden).toBe(true);
});

test("delta frames carry the additive fields onto the materialized frame", () => {
  const decoder = new WebHostOutputDecoder();
  decoder.feed(encoder.encode(
    "\u001Esurface:" + JSON.stringify({
      version: 2,
      sequence: 1,
      width: 2,
      height: 1,
      styles: [null],
      rows: [[[0, "x", 1, 0]]],
    }) + "\n"
  ));

  const records = decoder.feed(encoder.encode(
    "\u001Esurface:" + JSON.stringify({
      version: 3,
      encoding: "delta",
      sequence: 2,
      width: 2,
      height: 1,
      styles: [null],
      deltaRows: [[0, [[0, "y", 1, 0]]]],
      links: [[0, [[0, 1, 0]]]],
      linkTargets: ["https://a.example"],
      focusPresentation: {
        semantics: "activate",
        prefersTextInput: false,
        hasFocusedRegion: true,
        focusedIdentity: "root/button",
      },
      preferredGridWidth: 5,
      preferredGridHeight: 3,
    }) + "\n"
  ));

  expect(records).toHaveLength(1);
  const frame = surfaceFrame(records[0]);
  expect(frame.rows[0]).toEqual([[0, "y", 1, 0]]);
  expect(frame.links).toEqual([[0, [[0, 1, 0]]]]);
  expect(frame.linkTargets).toEqual(["https://a.example"]);
  expect(frame.focusPresentation?.semantics).toBe("activate");
  expect(frame.preferredGridWidth).toBe(5);
  expect(frame.preferredGridHeight).toBe(3);
});

test("decoder parses the shared canonical totality fixture from swift-tui's encoder", () => {
  // web-surface-totality.txt is generated by swift-tui's
  // WebSurfaceWireTotalityTests and byte-compared across repos by the
  // coordination root's transport_fixture_sync gate — this is the test that
  // runs the REAL swift-tui encoder output through this decoder.
  const decoder = new WebHostOutputDecoder();
  const records = decoder.feed(encoder.encode(transportFixture("web-surface-totality")));

  expect(records).toHaveLength(1);
  const frame = surfaceFrame(records[0]);
  expect(frame.version).toBe(2);
  expect(frame.sequence).toBe(99);
  expect(frame.links).toEqual([[0, [[0, 2, 0], [2, 1, 1]]], [1, [[0, 2, 0]]]]);
  expect(frame.linkTargets).toEqual(["https://a.example/docs", "https://b.example"]);
  expect(frame.focusPresentation?.semantics).toBe("edit");
  expect(frame.focusPresentation?.prefersTextInput).toBe(true);
  expect(frame.preferredGridWidth).toBe(9);
  expect(frame.preferredGridHeight).toBe(8);
  expect(frame.accessibilityTree?.[0]?.hidden).toBe(true);
  expect(frame.scrollRegions).toHaveLength(1);
  expect(frame.images?.[0]?.format).toBe("png");
  expect(frame.damage?.requiresFullTextRepaint).toBe(false);
});

test("decoder parses the canonical composited-image fixture from swift-tui's encoder", () => {
  // web-surface-composited-image.txt byte-pins the image pre-blend contract:
  // a compositing-tagged attachment reaches the wire as the blended PNG
  // payload under its stable `blend:png:` content-hash ID. Generated by
  // swift-tui's WebSurfaceWireTotalityTests and byte-compared across repos by
  // the coordination root's transport_fixture_sync gate.
  const decoder = new WebHostOutputDecoder();
  const records = decoder.feed(
    encoder.encode(transportFixture("web-surface-composited-image"))
  );

  expect(records).toHaveLength(1);
  const frame = surfaceFrame(records[0]);
  expect(frame.version).toBe(2);
  expect(frame.sequence).toBe(41);
  const image = frame.images?.[0];
  expect(image?.id).toMatch(/^blend:png:/);
  expect(image?.format).toBe("png");
  expect(image?.dataBase64).toBeDefined();
  expect(image?.scalingMode).toBe("fit");
  expect(image?.pixelSize).toEqual([2, 2]);
  expect(image?.bounds).toEqual([0, 0, 1, 1]);
});

test("the capability declaration matches the canonical cross-repo record fixture", () => {
  // web-caps-record.txt is the cross-repo canonical caps record: swift-tui's
  // WebSurfaceInputParser parses a byte-identical copy in its own suite, and
  // the coordination root's transport_fixture_sync gate keeps the copies in
  // lockstep — so the client cannot change its declaration bytes without the
  // Swift parse side re-proving them.
  const decoderText = new TextDecoder();
  expect(decoderText.decode(encodeCapabilitiesControlMessage()))
    .toBe(transportFixture("web-caps-record"));
});

test("surface records declaring a newer version surface an error-severity issue", () => {
  const decoder = new WebHostOutputDecoder();
  const records = decoder.feed(encoder.encode(
    "\u001Esurface:" + JSON.stringify({
      version: SUPPORTED_SURFACE_VERSION + 1,
      width: 2,
      height: 1,
      styles: [null],
      rows: [[]],
    }) + "\n"
  ));

  expect(records).toHaveLength(1);
  const record = records[0];
  if (record?.type !== "runtimeIssue") {
    throw new Error(`expected runtimeIssue record, got ${record?.type ?? "undefined"}`);
  }
  expect(record.issue.severity).toBe("error");
  expect(record.issue.code).toBe("surface.unsupportedVersion");
  expect(record.issue.message).toContain(`${SUPPORTED_SURFACE_VERSION + 1}`);
  expect(record.issue.description).toContain("@swifttui/web");
});

test("malformed same-version surface records still degrade to text", () => {
  const decoder = new WebHostOutputDecoder();
  const line = "\u001Esurface:" + JSON.stringify({ version: 2, width: 2 }) + "\n";

  expect(decoder.feed(encoder.encode(line))).toEqual([
    { type: "text", text: line },
  ]);
});

test("malformed hyperlink runs degrade the record to a text diagnostic", () => {
  const decoder = new WebHostOutputDecoder();
  const line = "\u001Esurface:" + JSON.stringify({
    version: 2,
    width: 2,
    height: 1,
    styles: [null],
    rows: [[]],
    links: [[0, [[0, 2]]]],
    linkTargets: ["https://a.example"],
  }) + "\n";

  const records = decoder.feed(encoder.encode(line));
  expect(records).toEqual([{ type: "text", text: line }]);
});

function surfaceFrame(
  record: WebHostOutputRecord | undefined
): WebHostSurfaceFrame {
  if (record?.type !== "surface") {
    throw new Error(`expected surface record, got ${record?.type ?? "undefined"}`);
  }
  return record.frame;
}
