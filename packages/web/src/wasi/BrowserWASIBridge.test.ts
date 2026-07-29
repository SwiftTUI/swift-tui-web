import { expect, test } from "bun:test";

import {
  BrowserWASIBridge,
  encodeRenderStyleControlMessage,
  encodeResizeControlMessage,
} from "./BrowserWASIBridge.ts";
import {
  decodeWebHostTerminalRenderStyleBase64,
  encodeWebHostTerminalRenderStyleBase64,
} from "../WebHostTerminalStyle.ts";

test("bridge seeds initial render style and emits runtime style updates", async () => {
  const style = {
    theme: {
      foreground: "#ededed",
      background: "#111111",
      tint: "#56b6c2",
      separator: "#4c566a",
      selection: "#2e3440",
      placeholder: "#8c92ac",
      link: "#5ba3ff",
      fill: "#2b303b",
      windowBackground: "#15181e",
      success: "#61c67b",
      warning: "#ebb33c",
      danger: "#e05757",
      info: "#56b6c2",
      muted: "#8c92ac",
    },
  };

  const bridge = new BrowserWASIBridge({
    sceneId: "main",
    columns: 80,
    rows: 24,
    renderStyle: style,
  });

  expect(
    decodeWebHostTerminalRenderStyleBase64(bridge.environment.SWIFTTUI_RENDER_STYLE ?? "")
      ?.appearance.backgroundColor
  ).toBe("#111111");
  expect(
    bridge.environment.SWIFTTUI_RENDER_STYLE
  ).toBe(encodeWebHostTerminalRenderStyleBase64(style));
  expect(bridge.environment.SWIFTTUI_TRANSPORT).toBe("surface");
  expect(bridge.environment.SWIFTTUI_SURFACE_DELTA).toBe("1");

  bridge.updateRenderStyle(style);
  const input = await bridge.stdin.read();
  expect(Array.from(input ?? [])).toEqual(
    Array.from(encodeRenderStyleControlMessage(style))
  );
});

test("bridge defaults the render mode to async-no-cancel with caller override", () => {
  const bridge = new BrowserWASIBridge({
    sceneId: "main",
    columns: 80,
    rows: 24,
  });

  expect(bridge.environment.SWIFTTUI_RENDER_MODE).toBe("async-no-cancel");

  const overridden = new BrowserWASIBridge({
    sceneId: "main",
    columns: 80,
    rows: 24,
    environment: {
      SWIFTTUI_RENDER_MODE: "async",
    },
  });

  expect(overridden.environment.SWIFTTUI_RENDER_MODE).toBe("async");
});

test("bridge allows callers to disable surface delta support", () => {
  const bridge = new BrowserWASIBridge({
    sceneId: "main",
    columns: 80,
    rows: 24,
    environment: {
      SWIFTTUI_SURFACE_DELTA: "0",
    },
  });

  expect(bridge.environment.SWIFTTUI_SURFACE_DELTA).toBe("0");
});

test("bridge resize updates environment, emits control input, and notifies listeners", async () => {
  const bridge = new BrowserWASIBridge({
    sceneId: "main",
    columns: 80,
    rows: 24,
  });
  const seen: Array<[number, number, number | undefined, number | undefined]> = [];
  const unsubscribe = bridge.subscribeResize((columns, rows, cellWidth, cellHeight) => {
    seen.push([columns, rows, cellWidth, cellHeight]);
  });

  expect(seen).toEqual([[80, 24, undefined, undefined]]);

  bridge.resize(132, 41, 9, 18);

  expect(bridge.environment.SWIFTTUI_COLUMNS).toBe("132");
  expect(bridge.environment.SWIFTTUI_ROWS).toBe("41");
  expect(seen).toEqual([
    [80, 24, undefined, undefined],
    [132, 41, 9, 18],
  ]);

  const input = await bridge.stdin.read();
  expect(Array.from(input ?? [])).toEqual(Array.from(encodeResizeControlMessage(132, 41, 9, 18)));

  unsubscribe();
  bridge.resize(90, 30);
  expect(seen).toEqual([
    [80, 24, undefined, undefined],
    [132, 41, 9, 18],
  ]);

  const replayed: Array<[number, number, number | undefined, number | undefined]> = [];
  bridge.subscribeResize((columns, rows, cellWidth, cellHeight) => {
    replayed.push([columns, rows, cellWidth, cellHeight]);
  })();
  expect(replayed).toEqual([[90, 30, undefined, undefined]]);
});

test("bridge delivers typed clipboard output to sinks", () => {
  const bridge = new BrowserWASIBridge({
    sceneId: "main",
    columns: 80,
    rows: 24,
  });
  const clipboard: string[] = [];

  bridge.bindOutput({
    presentSurface: () => {},
    writeClipboard: (text) => clipboard.push(text),
  });

  bridge.stdout.write(new TextEncoder().encode('\u001Eclipboard:{"text":"copied text"}\n'));

  expect(clipboard).toEqual(["copied text"]);
});

test("bridge consumes a delta without a baseline as a silent no-op", () => {
  const bridge = new BrowserWASIBridge({
    sceneId: "main",
    columns: 80,
    rows: 24,
  });
  const frames: unknown[] = [];
  const text: string[] = [];

  bridge.bindOutput({
    presentSurface: (frame) => frames.push(frame),
    writeOutput: (chunk) => text.push(chunk),
  });

  bridge.stdout.write(new TextEncoder().encode(
    '\u001Esurface:{"version":3,"encoding":"delta","width":2,"height":1,'
      + '"styles":[null],"deltaRows":[[0,[]]]}\n'
  ));

  expect(frames).toEqual([]);
  expect(text).toEqual([]);
});

test("bridge writes a keyframe resync for a stamped dimension mismatch and recovers", async () => {
  const bridge = new BrowserWASIBridge({
    sceneId: "main",
    columns: 80,
    rows: 24,
  });
  const frames: unknown[] = [];
  bridge.bindOutput({
    presentSurface: (frame) => frames.push(frame),
  });

  bridge.stdout.write(new TextEncoder().encode(
    "\u001Esurface:" + JSON.stringify({
      version: 2,
      epoch: 41,
      gen: 1,
      width: 2,
      height: 1,
      styles: [null],
      rows: [[[0, "A", 1, 0]]],
    }) + "\n"
      + "\u001Esurface:" + JSON.stringify({
        version: 3,
        encoding: "delta",
        epoch: 41,
        gen: 2,
        baselineGen: 1,
        width: 3,
        height: 1,
        styles: [null],
        deltaRows: [[0, [[0, "wrong-size", 1, 0]]]],
      }) + "\n"
  ));

  expect(frames).toHaveLength(1);
  expect(new TextDecoder().decode(await bridge.stdin.read()))
    .toBe('\u001Eresync:{"scope":"keyframe"}\n');

  bridge.stdout.write(new TextEncoder().encode(
    "\u001Esurface:" + JSON.stringify({
      version: 2,
      epoch: 41,
      gen: 3,
      width: 3,
      height: 1,
      styles: [null],
      rows: [[[0, "B", 1, 0]]],
    }) + "\n"
      + "\u001Esurface:" + JSON.stringify({
        version: 3,
        encoding: "delta",
        epoch: 41,
        gen: 4,
        baselineGen: 3,
        width: 3,
        height: 1,
        styles: [null],
        deltaRows: [[0, [[0, "C", 1, 0]]]],
      }) + "\n"
  ));

  expect(frames).toHaveLength(3);
  expect(frames.at(-1)).toMatchObject({
    epoch: 41,
    gen: 4,
    rows: [[[0, "C", 1, 0]]],
  });
});

test("bridge delivers typed runtime issues and frame diagnostics to sinks", () => {
  const bridge = new BrowserWASIBridge({
    sceneId: "main",
    columns: 80,
    rows: 24,
  });
  const runtimeIssues: unknown[] = [];
  const frameDiagnostics: unknown[] = [];
  const text: string[] = [];

  bridge.bindOutput({
    presentSurface: () => {},
    notifyRuntimeIssue: (issue) => runtimeIssues.push(issue),
    recordFrameDiagnostic: (diagnostic) => frameDiagnostics.push(diagnostic),
    writeOutput: (chunk) => text.push(chunk),
  });

  bridge.stdout.write(new TextEncoder().encode(
    '\u001EruntimeIssue:{"severity":"warning","code":"toolbar.unhostedItems",'
      + '"message":"Toolbar item was not rendered",'
      + '"description":"SwiftTUI runtime warning [toolbar.unhostedItems] Toolbar item was not rendered"}\n'
      + '\u001EframeDiagnostic:{"format":"swift-tui-frame-diagnostics-v1",'
      + '"header":["frame","total_ms"],"fields":["7","14.20"]}\n'
  ));

  expect(runtimeIssues).toEqual([
    {
      severity: "warning",
      code: "toolbar.unhostedItems",
      message: "Toolbar item was not rendered",
      description: "SwiftTUI runtime warning [toolbar.unhostedItems] Toolbar item was not rendered",
    },
  ]);
  expect(frameDiagnostics).toEqual([
    {
      format: "swift-tui-frame-diagnostics-v1",
      header: ["frame", "total_ms"],
      fields: ["7", "14.20"],
    },
  ]);
  expect(text).toEqual([]);
});
