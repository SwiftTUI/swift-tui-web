import { expect, test } from "bun:test";

import {
  WebSocketSceneBridge,
  webSocketSceneURL,
  type WebSocketSceneSocket,
} from "./WebSocketSceneBridge.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

class FakeWebSocket implements WebSocketSceneSocket {
  binaryType: BinaryType = "blob";
  readyState = 0;
  readonly sent: Uint8Array[] = [];
  closeCode?: number;
  closeReason?: string;
  failSendAttempt?: number;

  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  private sendAttempts = 0;

  send(
    data: string | ArrayBufferLike | Blob | ArrayBufferView
  ): void {
    this.sendAttempts += 1;
    if (this.sendAttempts === this.failSendAttempt) {
      throw new Error("injected send failure");
    }
    if (typeof data === "string") {
      this.sent.push(encoder.encode(data));
    } else if (data instanceof Uint8Array) {
      this.sent.push(new Uint8Array(data));
    } else if (data instanceof ArrayBuffer) {
      this.sent.push(new Uint8Array(data));
    } else if (ArrayBuffer.isView(data)) {
      this.sent.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    } else {
      throw new Error("fake socket does not support Blob sends");
    }
  }

  close(
    code?: number,
    reason?: string
  ): void {
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3;
  }

  addEventListener(
    type: string,
    listener: (event: unknown) => void
  ): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(
    type: string,
    listener: (event: unknown) => void
  ): void {
    this.listeners.get(type)?.delete(listener);
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  message(
    data: unknown
  ): void {
    this.emit("message", { data });
  }

  private emit(
    type: string,
    event: unknown
  ): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

test("websocket scene URLs use the embedded host path and token", () => {
  expect(String(webSocketSceneURL({
    sceneId: "main",
    token: "test-token",
    baseURL: "http://127.0.0.1:9123/",
  }))).toBe("ws://127.0.0.1:9123/ws/scene/main?token=test-token");

  expect(String(webSocketSceneURL({
    sceneId: "main",
    token: "secure-token",
    baseURL: "https://localhost:9443/app/",
  }))).toBe("wss://localhost:9443/app/ws/scene/main?token=secure-token");
});

test("bridge decodes websocket output and sends queued input when the socket opens", async () => {
  const socket = new FakeWebSocket();
  const bridge = new WebSocketSceneBridge({
    sceneId: "main",
    token: "test-token",
    baseURL: "http://127.0.0.1:9123/",
    webSocketFactory: () => socket,
  });
  const frames: unknown[] = [];
  const text: string[] = [];
  const clipboard: string[] = [];
  const runtimeIssues: unknown[] = [];
  const frameDiagnostics: unknown[] = [];

  bridge.bindOutput({
    presentSurface: (frame) => frames.push(frame),
    writeClipboard: (value) => clipboard.push(value),
    notifyRuntimeIssue: (issue) => runtimeIssues.push(issue),
    recordFrameDiagnostic: (diagnostic) => frameDiagnostics.push(diagnostic),
    writeOutput: (chunk) => text.push(chunk),
  });

  bridge.resize(100, 32, 9, 18);
  expect(socket.sent).toHaveLength(0);

  socket.open();
  // The capability declaration always flushes first (queued at
  // construction), ahead of any caller-queued record.
  expect(decoder.decode(socket.sent[0])).toBe(
    '\u001Ecaps:{"acceptsDeltaFrames":true,"styleAppend":true}\n'
  );
  expect(decoder.decode(socket.sent[1])).toBe("\u001Eresize:100:32:9:18\n");

  socket.message(encoder.encode(
    '\u001Esurface:{"version":3,"encoding":"delta","width":2,"height":1,'
      + '"styles":[null],"deltaRows":[[0,[]]]}\n'
      + '\u001Esurface:{"version":2,"width":2,"height":1,"styles":[null],"rows":[[]],'
      + '"accessibilityTree":[{"id":"root","rect":[0,0,2,1],"role":"group"}]}\n'
      + '\u001Eclipboard:{"text":"copied text"}\n'
      + '\u001EruntimeIssue:{"severity":"warning","code":"toolbar.unhostedItems",'
      + '"message":"Toolbar item was not rendered",'
      + '"description":"SwiftTUI runtime warning [toolbar.unhostedItems] Toolbar item was not rendered"}\n'
      + '\u001EframeDiagnostic:{"format":"swift-tui-frame-diagnostics-v1",'
      + '"header":["frame","total_ms"],"fields":["7","14.20"]}\n'
      + "legacy output\n"
  ));
  await Promise.resolve();

  expect(frames).toHaveLength(1);
  expect(frames[0]).toMatchObject({
    version: 2,
    width: 2,
    accessibilityTree: [{ id: "root", role: "group" }],
  });
  expect(clipboard).toEqual(["copied text"]);
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
  expect(text).toEqual(["legacy output\n"]);

  bridge.sendInput(encoder.encode("\u001Ekey:return:0\n"));
  expect(decoder.decode(socket.sent.at(-1))).toBe("\u001Ekey:return:0\n");

  bridge.dispose();
  expect(socket.closeCode).toBe(1000);
  expect(socket.closeReason).toBe("WebHost scene disposed");
});

test("bridge buffers output until a runtime binds a sink", async () => {
  const socket = new FakeWebSocket();
  const bridge = new WebSocketSceneBridge({
    sceneId: "main",
    token: "test-token",
    baseURL: "http://127.0.0.1:9123/",
    webSocketFactory: () => socket,
  });
  const frames: unknown[] = [];

  socket.message(encoder.encode(
    '\u001Esurface:{"version":1,"width":3,"height":1,"styles":[null],"rows":[[]]}\n'
  ));
  await Promise.resolve();

  bridge.bindOutput({
    presentSurface: (frame) => frames.push(frame),
  });

  expect(frames).toEqual([
    {
      version: 1,
      width: 3,
      height: 1,
      styles: [null],
      rows: [[]],
    },
  ]);
});

test("bridge dedupes keyframe requests until a stamped baseline recovers", async () => {
  const socket = new FakeWebSocket();
  const bridge = new WebSocketSceneBridge({
    sceneId: "main",
    token: "test-token",
    baseURL: "http://127.0.0.1:9123/",
    webSocketFactory: () => socket,
  });
  const frames: unknown[] = [];
  bridge.bindOutput({
    presentSurface: (frame) => frames.push(frame),
  });
  socket.open();

  socket.message(encoder.encode(
    "\u001Esurface:" + JSON.stringify({
      version: 3,
      encoding: "delta",
      epoch: 29,
      gen: 2,
      baselineGen: 1,
      width: 2,
      height: 1,
      styles: [null],
      deltaRows: [[0, [[0, "lost-baseline", 1, 0]]]],
    }) + "\n"
  ));
  await Promise.resolve();

  expect(frames).toHaveLength(0);
  expect(decoder.decode(socket.sent.at(-1)))
    .toBe('\u001Eresync:{"scope":"keyframe"}\n');

  socket.message(encoder.encode(
    "\u001Esurface:" + JSON.stringify({
      version: 3,
      encoding: "delta",
      epoch: 29,
      gen: 2,
      baselineGen: 1,
      width: 2,
      height: 1,
      styles: [null],
      deltaRows: [[0, [[0, "still-lost", 1, 0]]]],
    }) + "\n"
  ));
  await Promise.resolve();
  expect(socket.sent.filter(
    (chunk) => decoder.decode(chunk) === '\u001Eresync:{"scope":"keyframe"}\n'
  )).toHaveLength(1);

  socket.message(encoder.encode(
    "\u001Esurface:" + JSON.stringify({
      version: 2,
      epoch: 29,
      gen: 3,
      width: 2,
      height: 1,
      styles: [null],
      rows: [[[0, "B", 1, 0]]],
    }) + "\n"
      + "\u001Esurface:" + JSON.stringify({
        version: 3,
        encoding: "delta",
        epoch: 29,
        gen: 4,
        baselineGen: 3,
        width: 2,
        height: 1,
        styles: [null],
        deltaRows: [[0, [[0, "C", 1, 0]]]],
      }) + "\n"
  ));
  await Promise.resolve();

  expect(frames).toHaveLength(2);
  expect(frames.at(-1)).toMatchObject({
    epoch: 29,
    gen: 4,
    rows: [[[0, "C", 1, 0]]],
  });
  expect(socket.sent.filter(
    (chunk) => decoder.decode(chunk) === '\u001Eresync:{"scope":"keyframe"}\n'
  )).toHaveLength(1);

  socket.message(encoder.encode(
    "\u001Esurface:" + JSON.stringify({
      version: 3,
      encoding: "delta",
      epoch: 29,
      gen: 6,
      baselineGen: 5,
      width: 2,
      height: 1,
      styles: [null],
      deltaRows: [[0, [[0, "new-loss", 1, 0]]]],
    }) + "\n"
  ));
  await Promise.resolve();
  expect(socket.sent.filter(
    (chunk) => decoder.decode(chunk) === '\u001Eresync:{"scope":"keyframe"}\n'
  )).toHaveLength(2);

  bridge.dispose();
});

test("websocket bridge sends coalesced image recovery and suppresses repeats until payload arrival", async () => {
  const socket = new FakeWebSocket();
  const bridge = new WebSocketSceneBridge({
    sceneId: "main",
    token: "test-token",
    baseURL: "http://127.0.0.1:9123/",
    webSocketFactory: () => socket,
  });
  bridge.bindOutput({ presentSurface: () => {} });
  socket.open();
  socket.message(encoder.encode(
    "\u001Esurface:" + JSON.stringify({
      version: 2,
      epoch: 70,
      gen: 1,
      width: 2,
      height: 1,
      styles: [null],
      rows: [[]],
    }) + "\n"
  ));
  await Promise.resolve();

  bridge.requestImagePayloads(["png:z", "png:a", "png:z"]);
  bridge.requestImagePayloads(["png:a"]);
  expect(socket.sent.map((chunk) => decoder.decode(chunk))).toEqual([
    '\u001Ecaps:{"acceptsDeltaFrames":true,"styleAppend":true}\n',
    '\u001Eresync:{"scope":"images","ids":["png:a","png:z"]}\n',
  ]);

  socket.message(encoder.encode(
    "\u001Esurface:" + JSON.stringify({
      version: 2,
      epoch: 70,
      gen: 2,
      width: 2,
      height: 1,
      styles: [null],
      rows: [[]],
      images: [
        {
          id: "png:a",
          format: "png",
          bounds: [0, 0, 1, 1],
          visibleBounds: [0, 0, 1, 1],
          scalingMode: "stretch",
          dataBase64: "QUJD",
        },
        {
          id: "png:z",
          format: "png",
          bounds: [1, 0, 1, 1],
          visibleBounds: [1, 0, 1, 1],
          scalingMode: "stretch",
        },
      ],
    }) + "\n"
  ));
  await Promise.resolve();
  bridge.requestImagePayloads(["png:a", "png:z"]);

  expect(socket.sent.map((chunk) => decoder.decode(chunk))).toEqual([
    '\u001Ecaps:{"acceptsDeltaFrames":true,"styleAppend":true}\n',
    '\u001Eresync:{"scope":"images","ids":["png:a","png:z"]}\n',
    '\u001Eresync:{"scope":"images","ids":["png:a"]}\n',
  ]);
  bridge.dispose();
});

test("same-chunk payload repair clears the earlier payload-less miss in presentation order", async () => {
  const socket = new FakeWebSocket();
  const bridge = new WebSocketSceneBridge({
    sceneId: "main",
    token: "test-token",
    baseURL: "http://127.0.0.1:9123/",
    webSocketFactory: () => socket,
  });
  socket.open();
  bridge.bindOutput({
    presentSurface: (frame) => {
      const missing = frame.images?.filter(
        (image) => image.dataBase64 === undefined
      ).map((image) => image.id) ?? [];
      if (missing.length > 0) {
        bridge.requestImagePayloads(missing);
      }
    },
  });

  socket.message(encoder.encode(payloadMissThenRepairChunk(101)));
  await Promise.resolve();
  bridge.requestImagePayloads(["png:same-chunk"]);

  expect(resyncMessages(socket)).toEqual([
    '\u001Eresync:{"scope":"images","ids":["png:same-chunk"]}\n',
    '\u001Eresync:{"scope":"images","ids":["png:same-chunk"]}\n',
  ]);
  bridge.dispose();
});

test("pre-bind payload repair backlog clears the earlier miss when finally presented", async () => {
  const socket = new FakeWebSocket();
  const bridge = new WebSocketSceneBridge({
    sceneId: "main",
    token: "test-token",
    baseURL: "http://127.0.0.1:9123/",
    webSocketFactory: () => socket,
  });
  socket.open();
  socket.message(encoder.encode(payloadMissThenRepairChunk(102)));
  await Promise.resolve();

  bridge.bindOutput({
    presentSurface: (frame) => {
      const missing = frame.images?.filter(
        (image) => image.dataBase64 === undefined
      ).map((image) => image.id) ?? [];
      if (missing.length > 0) {
        bridge.requestImagePayloads(missing);
      }
    },
  });
  bridge.requestImagePayloads(["png:same-chunk"]);

  expect(resyncMessages(socket)).toEqual([
    '\u001Eresync:{"scope":"images","ids":["png:same-chunk"]}\n',
    '\u001Eresync:{"scope":"images","ids":["png:same-chunk"]}\n',
  ]);
  bridge.dispose();
});

test("websocket queued send failure retains the request and preserves FIFO", () => {
  const socket = new FakeWebSocket();
  socket.failSendAttempt = 2;
  const bridge = new WebSocketSceneBridge({
    sceneId: "main",
    token: "test-token",
    baseURL: "http://127.0.0.1:9123/",
    webSocketFactory: () => socket,
  });
  bridge.requestImagePayloads(["png:queued"]);
  socket.open();

  expect(socket.sent.map((chunk) => decoder.decode(chunk))).toEqual([
    '\u001Ecaps:{"acceptsDeltaFrames":true,"styleAppend":true}\n',
  ]);

  bridge.sendInput(encoder.encode("\u001Ekey:return:0\n"));
  expect(socket.sent.map((chunk) => decoder.decode(chunk))).toEqual([
    '\u001Ecaps:{"acceptsDeltaFrames":true,"styleAppend":true}\n',
    '\u001Eresync:{"scope":"images","ids":["png:queued"]}\n',
    "\u001Ekey:return:0\n",
  ]);
  bridge.dispose();
});

function payloadMissThenRepairChunk(
  epoch: number
): string {
  const image = {
    id: "png:same-chunk",
    format: "png",
    bounds: [0, 0, 1, 1],
    visibleBounds: [0, 0, 1, 1],
    scalingMode: "stretch",
  };
  return "\u001Esurface:" + JSON.stringify({
    version: 2,
    epoch,
    gen: 1,
    width: 2,
    height: 1,
    styles: [null],
    rows: [[]],
    images: [image],
  }) + "\n"
    + "\u001Esurface:" + JSON.stringify({
      version: 2,
      epoch,
      gen: 2,
      width: 2,
      height: 1,
      styles: [null],
      rows: [[]],
      images: [{ ...image, dataBase64: "QUJD" }],
    }) + "\n";
}

function resyncMessages(
  socket: FakeWebSocket
): string[] {
  return socket.sent.map((chunk) => decoder.decode(chunk))
    .filter((message) => message.startsWith("\u001Eresync:"));
}
