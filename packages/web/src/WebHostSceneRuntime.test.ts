import { expect, spyOn, test } from "bun:test";
import { ManualAnimationFrameScheduler } from "./ManualAnimationFrameScheduler.ts";
import {
  WebHostSceneRuntime,
  type WebHostSurfacePaintedEvent,
  type WheelMode,
} from "./WebHostSceneRuntime.ts";
import {
  encodePasteInputMessage,
  encodeResyncControlMessage,
  type WebHostOutputSink,
} from "./WebHostSurfaceTransport.ts";
import { transportFixture } from "./WebHostTestFixtures.ts";
import {
  BrowserWASIBridge,
  encodeRenderStyleControlMessage,
  encodeResizeControlMessage,
} from "./wasi/BrowserWASIBridge.ts";
import {
  SharedInputQueueReader,
  sharedInputQueueDefaultCapacity,
} from "./wasi/SharedInputQueue.ts";
import {
  createWasmSceneRuntimeFactory,
  type WasmSceneInputWrittenEvent,
} from "./wasi/WasmSceneRuntime.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

test.each(["error", "warning"] as const)(
  "runtime issues reach the browser console at %s severity without stopping frames",
  async (severity) => {
    const dom = installFakeDOM();
    const log = spyOn(
      console,
      severity === "error" ? "error" : "warn",
    ).mockImplementation(() => {});
    try {
      const bridge = new BrowserWASIBridge({
        sceneId: "main",
        columns: 4,
        rows: 2,
      });
      const runtime = new WebHostSceneRuntime({
        mount: new FakeElement("div") as unknown as HTMLElement,
        descriptor: { id: "main", title: "Main", isDefault: true },
        style: {},
        bridge,
        onInput: () => {},
      });
      await runtime.mount();
      const issue = {
        severity,
        code: "lifecycle.userExitUnsupported",
        message:
          "Exit keys cannot end an app on this host. The session is still running.",
        description: `SwiftTUI runtime ${severity} [lifecycle.userExitUnsupported] Session is still running.`,
      };
      bridge.stdout.write(
        encoder.encode(`\u001eruntimeIssue:${JSON.stringify(issue)}\n`),
      );
      expect(log).toHaveBeenCalledWith(issue.description);

      bridge.stdout.write(
        encoder.encode(transportFixture("web-surface-styled")),
      );
      expect(
        fillTextOperations(dom.canvases[0]!.context, "A").length,
      ).toBeGreaterThan(0);
      runtime.dispose();
    } finally {
      log.mockRestore();
      dom.restore();
    }
  },
);

test("hidden scenes stay out of layout even after style updates", () => {
  const dom = installFakeDOM();
  try {
    const mount = new FakeElement("div");
    const runtime = new WebHostSceneRuntime({
      mount: mount as unknown as HTMLElement,
      descriptor: { id: "details", title: "Details", isDefault: false },
      style: {},
      onInput: () => {},
    });

    expect(runtime.element.hidden).toBe(true);
    expect(runtime.element.style.getPropertyValue("display")).toBe("none");
    expect(runtime.element.style.getPropertyPriority("display")).toBe(
      "important",
    );

    runtime.setStyle({ fontSize: 18 });
    expect(runtime.element.hidden).toBe(true);
    expect(runtime.element.style.getPropertyValue("display")).toBe("none");

    runtime.setVisible(true);
    expect(runtime.element.hidden).toBe(false);
    expect(runtime.element.style.getPropertyValue("display")).toBe("grid");

    runtime.setVisible(false);
    expect(runtime.element.hidden).toBe(true);
    expect(runtime.element.style.getPropertyValue("display")).toBe("none");
  } finally {
    dom.restore();
  }
});

test("runtime draws decoded surface frames into the canvas", async () => {
  const dom = installFakeDOM({ devicePixelRatio: 2 });
  try {
    const bridge = new BrowserWASIBridge({
      sceneId: "main",
      columns: 4,
      rows: 2,
    });
    const mount = new FakeElement("div");
    const runtime = new WebHostSceneRuntime({
      mount: mount as unknown as HTMLElement,
      descriptor: { id: "main", title: "Main", isDefault: true },
      style: {
        fontSize: 20,
        fontFamily: "Test Mono",
        theme: {
          foreground: "#eeeeee",
          background: "#101820",
        },
      },
      bridge,
      onInput: () => {},
    });

    await runtime.mount();

    expect(dom.canvases).toHaveLength(1);
    const canvas = dom.canvases[0]!;
    const context = canvas.context;

    context.operations = [];
    bridge.stdout.write(encoder.encode(transportFixture("web-surface-styled")));

    expect(canvas.width).toBe(200);
    expect(canvas.height).toBe(216);
    expect(canvas.style.width).toBe("100%");
    expect(canvas.style.height).toBe("100%");

    expect(context.operations).toContainEqual({
      type: "clearRect",
      x: 0,
      y: 0,
      width: 100,
      height: 108,
    });
    expect(context.operations).toContainEqual({
      type: "fillRect",
      x: 0,
      y: 0,
      width: 100,
      height: 108,
      fillStyle: "rgba(16, 24, 32, 1)",
      globalAlpha: 1,
    });

    expect(fillTextOperations(context, "A")).toEqual([
      {
        type: "fillText",
        text: "A",
        x: 0,
        y: 21,
        fillStyle: "#000000FF",
        font: "italic 700 20px Test Mono",
        globalAlpha: 0.75,
      },
    ]);
    expect(fillTextOperations(context, "界")).toHaveLength(1);
    expect(fillRectOperations(context, "#E05757FF")[0]).toMatchObject({
      x: 0,
      y: 0,
      width: 10,
      height: 27,
      globalAlpha: 0.75,
    });
    expect(fillRectOperations(context, "#61C67BFF")[0]).toMatchObject({
      x: 10,
      y: 0,
      width: 20,
      height: 27,
      globalAlpha: 0.5,
    });

    expect(fillRectOperations(context, "#EBB33CFF")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ x: 0, y: 24.5, width: 4, height: 1 }),
        expect.objectContaining({ x: 7, y: 24.5, width: 3, height: 1 }),
      ]),
    );
    expect(fillRectOperations(context, "#E05757FF")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ x: 0, y: 12.5, width: 1, height: 1 }),
        expect.objectContaining({ x: 4, y: 12.5, width: 1, height: 1 }),
      ]),
    );
  } finally {
    dom.restore();
  }
});

test("canvas and scene wrappers fill a non-cell-aligned mount without overflow", async () => {
  const dom = installFakeDOM({ devicePixelRatio: 2 });
  try {
    const resizes: Array<{ columns: number; rows: number }> = [];
    const mount = new FakeElement("div");
    const runtime = new WebHostSceneRuntime({
      mount: mount as unknown as HTMLElement,
      descriptor: { id: "main", title: "Main", isDefault: true },
      style: { fontSize: 20 },
      bridge: {
        bindOutput: () => {},
        resize: (columns, rows) => {
          resizes.push({ columns, rows });
        },
        updateRenderStyle: () => {},
        sendInput: () => {},
        dispose: () => {},
      },
      onInput: () => {},
    });
    const terminalMount = runtime.terminalMount as unknown as FakeElement;
    terminalMount.rect = {
      left: 0,
      top: 0,
      width: 103,
      height: 109,
      right: 103,
      bottom: 109,
    };

    await runtime.mount();

    expect(runtime.element.style.boxSizing).toBe("border-box");
    expect(runtime.element.style.width).toBe("100%");
    expect(runtime.element.style.height).toBe("100%");
    expect(runtime.element.style.resize).toBeUndefined();
    expect(runtime.element.style.overflow).toBe("hidden");
    expect(runtime.element.style.gridTemplateRows).toBe("auto minmax(0, 1fr)");
    expect(terminalMount.style.boxSizing).toBe("border-box");
    expect(terminalMount.style.width).toBe("100%");
    expect(terminalMount.style.height).toBe("100%");
    expect(terminalMount.style.minHeight).toBe("0");
    expect(terminalMount.style.overflow).toBe("hidden");

    const canvas = dom.canvases[0]!;
    expect(canvas.style.width).toBe("100%");
    expect(canvas.style.height).toBe("100%");
    expect(canvas.width).toBe(206);
    expect(canvas.height).toBe(218);
    expect(resizes.at(-1)).toEqual({ columns: 10, rows: 4 });
    expect(canvas.context.operations).toContainEqual({
      type: "fillRect",
      x: 0,
      y: 0,
      width: 103,
      height: 109,
      fillStyle: "rgba(30, 34, 42, 1)",
      globalAlpha: 1,
    });
  } finally {
    dom.restore();
  }
});

test("the resizable scene frame applies the standalone geometry", async () => {
  const dom = installFakeDOM();
  try {
    const mount = new FakeElement("div");
    const runtime = new WebHostSceneRuntime({
      mount: mount as unknown as HTMLElement,
      descriptor: { id: "main", title: "Main", isDefault: true },
      style: { fontSize: 20 },
      onInput: () => {},
      sceneFrame: "resizable",
    });
    const terminalMount = runtime.terminalMount as unknown as FakeElement;

    await runtime.mount();

    expect(runtime.element.style.width).toBe("80%");
    expect(runtime.element.style.height).toBe("80%");
    expect(runtime.element.style.maxWidth).toBe("100%");
    expect(runtime.element.style.maxHeight).toBe("100%");
    expect(runtime.element.style.resize).toBe("both");
    expect(runtime.element.style.flex).toBe("0 0 auto");
    expect(terminalMount.style.height).toBe("auto");
    expect(terminalMount.style.alignSelf).toBe("stretch");
  } finally {
    dom.restore();
  }
});

test("a container resize immediately repaints the retained frame at the new full size", async () => {
  const dom = installFakeDOM();
  try {
    const bridge = new BrowserWASIBridge({
      sceneId: "main",
      columns: 10,
      rows: 4,
    });
    const mount = new FakeElement("div");
    const runtime = new WebHostSceneRuntime({
      mount: mount as unknown as HTMLElement,
      descriptor: { id: "main", title: "Main", isDefault: true },
      style: { fontSize: 20, fontFamily: "Test Mono" },
      bridge,
      onInput: () => {},
    });
    const terminalMount = runtime.terminalMount as unknown as FakeElement;
    terminalMount.rect = {
      left: 0,
      top: 0,
      width: 103,
      height: 109,
      right: 103,
      bottom: 109,
    };
    await runtime.mount();
    bridge.stdout.write(
      encoder.encode(
        surfaceRecord({
          version: 1,
          width: 10,
          height: 4,
          styles: [null],
          rows: [[[0, "A", 1, 0]], [], [], []],
          images: [],
        }),
      ),
    );

    const canvas = dom.canvases[0]!;
    canvas.context.operations = [];
    terminalMount.rect = {
      left: 0,
      top: 0,
      width: 137,
      height: 143,
      right: 137,
      bottom: 143,
    };
    dom.triggerResize();

    expect(canvas.width).toBe(137);
    expect(canvas.height).toBe(143);
    expect(canvas.context.operations).toContainEqual({
      type: "fillRect",
      x: 0,
      y: 0,
      width: 137,
      height: 143,
      fillStyle: "rgba(30, 34, 42, 1)",
      globalAlpha: 1,
    });
    expect(fillTextOperations(canvas.context, "A")).toHaveLength(1);
  } finally {
    dom.restore();
  }
});

test("runtime redraws only damaged cells when a compatible frame includes damage", async () => {
  const dom = installFakeDOM();
  try {
    const bridge = new BrowserWASIBridge({
      sceneId: "main",
      columns: 4,
      rows: 2,
    });
    const mount = new FakeElement("div");
    const runtime = new WebHostSceneRuntime({
      mount: mount as unknown as HTMLElement,
      descriptor: { id: "main", title: "Main", isDefault: true },
      style: {
        fontSize: 20,
        fontFamily: "Test Mono",
      },
      bridge,
      onInput: () => {},
    });

    await runtime.mount();

    const canvas = dom.canvases[0]!;
    const context = canvas.context;
    bridge.stdout.write(
      encoder.encode(
        surfaceRecord({
          version: 1,
          width: 4,
          height: 2,
          styles: [null],
          rows: [
            [
              [0, "A", 1, 0],
              [1, "B", 1, 0],
            ],
            [
              [0, "C", 1, 0],
              [1, "D", 1, 0],
            ],
          ],
          images: [],
        }),
      ),
    );

    context.operations = [];
    bridge.stdout.write(
      encoder.encode(
        surfaceRecord({
          version: 1,
          width: 4,
          height: 2,
          styles: [null],
          rows: [
            [
              [0, "A", 1, 0],
              [1, "B", 1, 0],
            ],
            [
              [0, "X", 1, 0],
              [1, "D", 1, 0],
            ],
          ],
          images: [],
          damage: {
            textRows: [[1, [[0, 1]]]],
            requiresFullTextRepaint: false,
            requiresFullGraphicsReplay: false,
          },
        }),
      ),
    );

    expect(context.operations).toContainEqual({
      type: "clearRect",
      x: 0,
      y: 27,
      width: 10,
      height: 27,
    });
    expect(fillTextOperations(context, "X")).toHaveLength(1);
    expect(fillTextOperations(context, "A")).toEqual([]);
    expect(fillTextOperations(context, "D")).toEqual([]);
  } finally {
    dom.restore();
  }
});

test("runtime redraws spanning cells that overlap a dirty range", async () => {
  const dom = installFakeDOM();
  try {
    const bridge = new BrowserWASIBridge({
      sceneId: "main",
      columns: 6,
      rows: 1,
    });
    const mount = new FakeElement("div");
    const runtime = new WebHostSceneRuntime({
      mount: mount as unknown as HTMLElement,
      descriptor: { id: "main", title: "Main", isDefault: true },
      style: {
        fontSize: 20,
        fontFamily: "Test Mono",
      },
      bridge,
      onInput: () => {},
    });

    await runtime.mount();

    const canvas = dom.canvases[0]!;
    const context = canvas.context;
    bridge.stdout.write(
      encoder.encode(
        surfaceRecord({
          version: 1,
          width: 6,
          height: 1,
          styles: [null],
          rows: [
            [
              [0, "Wide", 4, 0],
              [4, "Z", 1, 0],
            ],
          ],
          images: [],
        }),
      ),
    );

    context.operations = [];
    bridge.stdout.write(
      encoder.encode(
        surfaceRecord({
          version: 1,
          width: 6,
          height: 1,
          styles: [null],
          rows: [
            [
              [0, "wide", 4, 0],
              [4, "Z", 1, 0],
            ],
          ],
          images: [],
          damage: {
            textRows: [[0, [[2, 3]]]],
            requiresFullTextRepaint: false,
            requiresFullGraphicsReplay: false,
          },
        }),
      ),
    );

    expect(context.operations).toContainEqual({
      type: "clearRect",
      x: 20,
      y: 0,
      width: 10,
      height: 27,
    });
    expect(fillTextOperations(context, "wide")).toHaveLength(1);
    expect(fillTextOperations(context, "Z")).toEqual([]);
  } finally {
    dom.restore();
  }
});

test("runtime clears stale overlay text when dirty rects remove an overlay", async () => {
  const dom = installFakeDOM();
  try {
    const bridge = new BrowserWASIBridge({
      sceneId: "main",
      columns: 24,
      rows: 4,
    });
    const mount = new FakeElement("div");
    const runtime = new WebHostSceneRuntime({
      mount: mount as unknown as HTMLElement,
      descriptor: { id: "main", title: "Main", isDefault: true },
      style: {
        fontSize: 20,
        fontFamily: "Test Mono",
      },
      bridge,
      onInput: () => {},
    });

    await runtime.mount();

    const canvas = dom.canvases[0]!;
    const context = canvas.context;
    context.operations = [];

    bridge.stdout.write(
      encoder.encode(
        surfaceRecord({
          version: 1,
          width: 24,
          height: 4,
          styles: [null],
          rows: [[[0, "Base content", 12, 0]], [], [], []],
          images: [],
        }),
      ),
    );
    bridge.stdout.write(
      encoder.encode(
        surfaceRecord({
          version: 1,
          width: 24,
          height: 4,
          styles: [null],
          rows: [
            [[0, "Base content", 12, 0]],
            [[0, "Command palette", 15, 0]],
            [[0, "Search actions", 14, 0]],
            [],
          ],
          images: [],
          damage: {
            textRows: [
              [1, [[0, 24]]],
              [2, [[0, 24]]],
            ],
            requiresFullTextRepaint: false,
            requiresFullGraphicsReplay: false,
          },
        }),
      ),
    );

    const overlayText = readCanvasTextLikePixels(canvas);
    expect(overlayText).toContain("Command palette");
    expect(overlayText).toContain("Search actions");

    bridge.stdout.write(
      encoder.encode(
        surfaceRecord({
          version: 1,
          width: 24,
          height: 4,
          styles: [null],
          rows: [[[0, "Base content", 12, 0]], [], [], []],
          images: [],
          damage: {
            textRows: [
              [1, [[0, 24]]],
              [2, [[0, 24]]],
            ],
            requiresFullTextRepaint: false,
            requiresFullGraphicsReplay: false,
          },
        }),
      ),
    );

    const dismissedText = readCanvasTextLikePixels(canvas);
    expect(dismissedText).not.toContain("Command palette");
    expect(dismissedText).not.toContain("Search actions");
  } finally {
    dom.restore();
  }
});

test("runtime skips canvas drawing for compatible empty damage", async () => {
  const dom = installFakeDOM();
  try {
    const bridge = new BrowserWASIBridge({
      sceneId: "main",
      columns: 4,
      rows: 2,
    });
    const mount = new FakeElement("div");
    const runtime = new WebHostSceneRuntime({
      mount: mount as unknown as HTMLElement,
      descriptor: { id: "main", title: "Main", isDefault: true },
      style: { fontSize: 20, fontFamily: "Test Mono" },
      bridge,
      onInput: () => {},
    });

    await runtime.mount();
    bridge.stdout.write(
      encoder.encode(
        surfaceRecord({
          version: 1,
          width: 4,
          height: 2,
          styles: [null],
          rows: [[[0, "A", 1, 0]], []],
          images: [],
        }),
      ),
    );

    const context = dom.canvases[0]!.context;
    context.operations = [];
    bridge.stdout.write(
      encoder.encode(
        surfaceRecord({
          version: 1,
          width: 4,
          height: 2,
          styles: [null],
          rows: [[[0, "A", 1, 0]], []],
          images: [],
          damage: {
            textRows: [],
            requiresFullTextRepaint: false,
            requiresFullGraphicsReplay: false,
          },
        }),
      ),
    );

    expect(context.operations).toEqual([]);
  } finally {
    dom.restore();
  }
});

test("runtime clears dirty rows when an image disappears", async () => {
  const dom = installFakeDOM({
    createImageBitmap: async () => ({ imageId: "decoded-image" }),
  });
  try {
    const bridge = new BrowserWASIBridge({
      sceneId: "main",
      columns: 4,
      rows: 2,
    });
    const mount = new FakeElement("div");
    const runtime = new WebHostSceneRuntime({
      mount: mount as unknown as HTMLElement,
      descriptor: { id: "main", title: "Main", isDefault: true },
      style: { fontSize: 20, fontFamily: "Test Mono" },
      bridge,
      onInput: () => {},
    });

    await runtime.mount();
    bridge.stdout.write(
      encoder.encode(
        surfaceRecord({
          version: 1,
          width: 4,
          height: 2,
          styles: [null],
          rows: [[[0, "A", 1, 0]], [[0, "B", 1, 0]]],
          images: [
            {
              id: "png:test",
              format: "png",
              bounds: [1, 1, 2, 1],
              visibleBounds: [1, 1, 2, 1],
              scalingMode: "stretch",
              dataBase64:
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5L8AAAAASUVORK5CYII=",
            },
          ],
        }),
      ),
    );
    await flushPromises();

    const context = dom.canvases[0]!.context;
    context.operations = [];
    bridge.stdout.write(
      encoder.encode(
        surfaceRecord({
          version: 1,
          width: 4,
          height: 2,
          styles: [null],
          rows: [[[0, "A", 1, 0]], [[0, "B", 1, 0]]],
          images: [],
          damage: {
            textRows: [[1, [[1, 3]]]],
            requiresFullTextRepaint: false,
            requiresFullGraphicsReplay: false,
          },
        }),
      ),
    );

    expect(context.operations).toContainEqual({
      type: "clearRect",
      x: 10,
      y: 27,
      width: 20,
      height: 27,
    });
    expect(drawImageOperations(context)).toEqual([]);
    expect(fillTextOperations(context, "A")).toEqual([]);
  } finally {
    dom.restore();
  }
});

test("WASI runtime forwards bridge control input into the worker queue", async () => {
  const dom = installFakeDOM();
  const previousWorker = globalThis.Worker;
  const postedMessages: Array<{
    inputQueue?: ConstructorParameters<typeof SharedInputQueueReader>[0];
  }> = [];

  class FakeWorker {
    constructor(_url: string | URL, _options?: WorkerOptions) {}

    addEventListener(_type: string, _listener: EventListener): void {}

    postMessage(message: {
      inputQueue?: ConstructorParameters<typeof SharedInputQueueReader>[0];
    }): void {
      postedMessages.push(message);
    }

    terminate(): void {}
  }

  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  try {
    const bridge = new BrowserWASIBridge({
      sceneId: "main",
      columns: 4,
      rows: 2,
    });
    const mount = new FakeElement("div");
    const runtime = createWasmSceneRuntimeFactory(
      new URL("https://example.test/app.wasm"),
      {
        workerModuleURL: "fake-worker.js",
      },
    )({
      mount: mount as unknown as HTMLElement,
      descriptor: { id: "main", title: "Main", isDefault: true },
      style: { fontSize: 20 },
      bridge,
      onInput: () => {},
    });

    await runtime.mount();
    const inputQueue = postedMessages[0]?.inputQueue;
    if (!inputQueue) {
      throw new Error("worker did not receive an input queue");
    }
    const reader = new SharedInputQueueReader(inputQueue);
    reader.readAvailable(reader.availableBytes());

    const style = { cursorBlink: true };
    bridge.updateRenderStyle(style);
    const styleBytes = reader.readAvailable(reader.availableBytes());
    expect(Array.from(styleBytes ?? [])).toEqual(
      Array.from(encodeRenderStyleControlMessage(style)),
    );

    bridge.resize(10, 4, 9, 18);
    const resizeBytes = reader.readAvailable(reader.availableBytes());
    expect(Array.from(resizeBytes ?? [])).toEqual(
      Array.from(encodeResizeControlMessage(10, 4, 9, 18)),
    );

    runtime.dispose();
  } finally {
    globalThis.Worker = previousWorker;
    dom.restore();
  }
});

test("WASI runtime reports each logical input write as it settles", async () => {
  const dom = installFakeDOM();
  const previousWorker = globalThis.Worker;

  class FakeWorker {
    constructor(_url: string | URL, _options?: WorkerOptions) {}

    addEventListener(_type: string, _listener: EventListener): void {}

    postMessage(_message: unknown): void {}

    terminate(): void {}
  }

  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  try {
    const bridge = new BrowserWASIBridge({
      sceneId: "main",
      columns: 4,
      rows: 2,
    });
    const written: WasmSceneInputWrittenEvent[] = [];
    const mount = new FakeElement("div");
    const runtime = createWasmSceneRuntimeFactory(
      new URL("https://example.test/app.wasm"),
      {
        workerModuleURL: "fake-worker.js",
        onInputWritten: (event) => written.push(event),
      },
    )({
      mount: mount as unknown as HTMLElement,
      descriptor: { id: "main", title: "Main", isDefault: true },
      style: { fontSize: 20 },
      bridge,
      onInput: () => {},
    });

    await runtime.mount();
    // Mount-time control writes (capabilities, resize) settle on microtasks.
    await Promise.resolve();
    written.length = 0;

    const chunk = encoder.encode("\u001b[A");
    const before = performance.now();
    runtime.sendInput(chunk);
    // The synchronous fast path stores the bytes at once; the report follows
    // on the write promise's microtask, so it is never delivered re-entrantly.
    expect(written).toHaveLength(0);
    await Promise.resolve();
    expect(written).toEqual([
      {
        bytes: chunk.length,
        writtenAt: expect.any(Number),
        status: "written",
        bytesWritten: chunk.length,
      },
    ]);
    expect(written[0]!.writtenAt).toBeGreaterThanOrEqual(before);

    runtime.dispose();
  } finally {
    globalThis.Worker = previousWorker;
    dom.restore();
  }
});

test("WASI retries one keyframe resync after shared input capacity returns", async () => {
  const dom = installFakeDOM();
  const previousWorker = globalThis.Worker;
  const previousConsoleError = console.error;
  const postedMessages: Array<{
    inputQueue?: ConstructorParameters<typeof SharedInputQueueReader>[0];
  }> = [];
  const consoleErrors: unknown[][] = [];

  class FakeWorker {
    constructor(_url: string | URL, _options?: WorkerOptions) {}

    addEventListener(_type: string, _listener: EventListener): void {}

    postMessage(message: {
      inputQueue?: ConstructorParameters<typeof SharedInputQueueReader>[0];
    }): void {
      postedMessages.push(message);
    }

    terminate(): void {}
  }

  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  console.error = (...arguments_: unknown[]): void => {
    consoleErrors.push(arguments_);
  };

  try {
    const bridge = new BrowserWASIBridge({
      sceneId: "main",
      columns: 4,
      rows: 2,
    });
    const runtime = createWasmSceneRuntimeFactory(
      new URL("https://example.test/app.wasm"),
      { workerModuleURL: "fake-worker.js" },
    )({
      mount: new FakeElement("div") as unknown as HTMLElement,
      descriptor: { id: "main", title: "Main", isDefault: true },
      style: { fontSize: 20 },
      bridge,
      onInput: () => {},
    });

    await runtime.mount();
    const inputQueue = postedMessages[0]?.inputQueue;
    if (!inputQueue) {
      throw new Error("worker did not receive an input queue");
    }
    const reader = new SharedInputQueueReader(inputQueue);
    reader.readAvailable(reader.availableBytes());

    const resync = encodeResyncControlMessage({ scope: "keyframe" });
    // One byte more than the ring can hold alongside the resync record, so the
    // resync cannot be written in one go.
    const filler = new Uint8Array(
      sharedInputQueueDefaultCapacity - resync.byteLength + 1,
    );
    bridge.sendInput(filler);
    expect(reader.availableBytes()).toBe(filler.byteLength);

    const missingBaselineDelta = surfaceRecord({
      version: 3,
      encoding: "delta",
      epoch: 7,
      gen: 2,
      baselineGen: 1,
      width: 4,
      height: 2,
      styles: [null],
      deltaRows: [[0, [[0, "lost", 1, 0]]]],
    });
    bridge.stdout.write(encoder.encode(missingBaselineDelta));

    // The resync request is no longer rejected for want of space: it streams
    // through the ring as the reader drains, so nothing is dropped and nothing
    // is reported.
    expect(
      Array.from(
        await drainExactly(reader, filler.byteLength + resync.byteLength),
      ).slice(filler.byteLength),
    ).toEqual(Array.from(resync));
    expect(consoleErrors).toEqual([]);

    // Still deduplicated: a second refused delta does not re-request while the
    // first keyframe request is outstanding.
    bridge.stdout.write(encoder.encode(missingBaselineDelta));
    expect(reader.availableBytes()).toBe(0);

    const imageResync = encodeResyncControlMessage({
      scope: "images",
      ids: ["png:capacity-retry"],
    });
    const imageFiller = new Uint8Array(
      sharedInputQueueDefaultCapacity - imageResync.byteLength + 1,
    );
    bridge.sendInput(imageFiller);
    bridge.requestImagePayloads(["png:capacity-retry"]);
    expect(
      Array.from(
        await drainExactly(
          reader,
          imageFiller.byteLength + imageResync.byteLength,
        ),
      ).slice(imageFiller.byteLength),
    ).toEqual(Array.from(imageResync));
    expect(consoleErrors).toEqual([]);

    bridge.requestImagePayloads(["png:capacity-retry"]);
    expect(reader.availableBytes()).toBe(0);

    runtime.dispose();
  } finally {
    console.error = previousConsoleError;
    globalThis.Worker = previousWorker;
    dom.restore();
  }
});

test("WASI input routing streams an oversized paste through the ring", async () => {
  const dom = installFakeDOM();
  const previousWorker = globalThis.Worker;
  const previousConsoleError = console.error;
  const postedMessages: Array<{
    inputQueue?: ConstructorParameters<typeof SharedInputQueueReader>[0];
  }> = [];
  const consoleErrors: unknown[][] = [];

  class FakeWorker {
    constructor(_url: string | URL, _options?: WorkerOptions) {}

    addEventListener(_type: string, _listener: EventListener): void {}

    postMessage(message: {
      inputQueue?: ConstructorParameters<typeof SharedInputQueueReader>[0];
    }): void {
      postedMessages.push(message);
    }

    terminate(): void {}
  }

  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  console.error = (...arguments_: unknown[]): void => {
    consoleErrors.push(arguments_);
  };

  try {
    const bridge = new BrowserWASIBridge({
      sceneId: "main",
      columns: 4,
      rows: 2,
    });
    const runtime = createWasmSceneRuntimeFactory(
      new URL("https://example.test/app.wasm"),
      { workerModuleURL: "fake-worker.js" },
    )({
      mount: new FakeElement("div") as unknown as HTMLElement,
      descriptor: { id: "main", title: "Main", isDefault: true },
      style: { fontSize: 20 },
      bridge,
      onInput: () => {},
    });

    await runtime.mount();
    const inputQueue = postedMessages[0]?.inputQueue;
    if (!inputQueue) {
      throw new Error("worker did not receive an input queue");
    }
    const reader = new SharedInputQueueReader(inputQueue);
    reader.readAvailable(reader.availableBytes());

    // Both of these exceed the 64 KiB ring by one byte, which used to drop the
    // whole clipboard. They now stream through it while the reader drains.
    const overflowingPastes = ["a".repeat(65_529), "界".repeat(7_281)];
    expect(
      overflowingPastes.map((text) => encodePasteInputMessage(text).byteLength),
    ).toEqual([65_537, 65_537]);

    for (const text of overflowingPastes) {
      let preventedDefault = false;
      runtime.terminalMount.dispatch("paste", {
        clipboardData: {
          getData: () => text,
        },
        preventDefault: () => {
          preventedDefault = true;
        },
      });
      expect(preventedDefault).toBe(true);

      // Drain like the worker would: the writer hands over what fits, waits for
      // the reader, and continues. Every byte arrives, in order, as one paste.
      const expected = encodePasteInputMessage(text);
      const received: number[] = [];
      for (
        let turn = 0;
        turn < 512 && received.length < expected.byteLength;
        turn += 1
      ) {
        const chunk = reader.readAvailable(expected.byteLength);
        if (chunk) {
          received.push(...chunk);
        }
        // A macrotask turn, not just a microtask: the writer resumes on the
        // reader's `Atomics.notify`, which lands in a task.
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
      }
      expect(received.length).toBe(expected.byteLength);
      expect(new Uint8Array(received)).toEqual(expected);
    }

    // Nothing was dropped, so nothing was reported.
    expect(consoleErrors).toEqual([]);

    runtime.dispose();
  } finally {
    console.error = previousConsoleError;
    globalThis.Worker = previousWorker;
    dom.restore();
  }
});

test("runtime mounts accessibility tree and announces live-region changes", async () => {
  const dom = installFakeDOM();
  try {
    const bridge = new BrowserWASIBridge({
      sceneId: "main",
      columns: 4,
      rows: 2,
    });
    const mount = new FakeElement("div");
    const runtime = new WebHostSceneRuntime({
      mount: mount as unknown as HTMLElement,
      descriptor: { id: "main", title: "Main", isDefault: true },
      style: {
        fontSize: 20,
        fontFamily: "Test Mono",
      },
      bridge,
      onInput: () => {},
    });

    await runtime.mount();

    const canvas = dom.canvases[0]!;
    expect(canvas.getAttribute("aria-hidden")).toBe("true");

    bridge.stdout.write(
      encoder.encode(
        surfaceRecord({
          version: 2,
          width: 4,
          height: 2,
          styles: [null],
          rows: [[], []],
          accessibilityTree: [
            {
              id: "root",
              rect: [0, 0, 4, 2],
              role: "group",
              label: "Root",
              isFocused: false,
            },
            {
              id: "root/button",
              parentId: "root",
              rect: [0, 0, 2, 1],
              role: "button",
              label: "Save",
              hint: "Writes the file",
              isFocused: true,
            },
            {
              id: "root/status",
              parentId: "root",
              rect: [0, 1, 2, 1],
              role: "status",
              label: "Idle",
              liveRegion: "polite",
              isFocused: false,
            },
            {
              id: "root/error",
              parentId: "root",
              rect: [2, 1, 2, 1],
              role: "alert",
              label: "Ready",
              liveRegion: "assertive",
              isFocused: false,
            },
          ],
          accessibilityAnnouncements: [
            { message: "Ready", politeness: "polite" },
          ],
        }),
      ),
    );

    const tree = childWithClass(
      runtime.terminalMount,
      "webhost-scene__accessibility-tree",
    );
    const announcer = childWithClass(
      runtime.terminalMount,
      "webhost-scene__accessibility-announcer",
    );
    const root = childWithData(tree, "accessibilityId", "root");
    const button = childWithData(root, "accessibilityId", "root/button");
    const status = childWithData(root, "accessibilityId", "root/status");

    expect(button.getAttribute("role")).toBe("button");
    expect(button.getAttribute("aria-label")).toBe("Save");
    expect(button.getAttribute("aria-description")).toBe("Writes the file");
    expect(button.focused).toBe(true);
    expect(button.lastFocusOptions).toEqual({ preventScroll: true });
    expect(status.getAttribute("role")).toBe("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.style.left).toBe("0px");
    expect(status.style.top).toBe("27px");
    expect(announcer.textContent).toBe("Ready");

    bridge.stdout.write(
      encoder.encode(
        surfaceRecord({
          version: 2,
          width: 4,
          height: 2,
          styles: [null],
          rows: [[], []],
          accessibilityTree: [
            {
              id: "root/status",
              rect: [0, 1, 2, 1],
              role: "status",
              label: "Saved",
              liveRegion: "polite",
              isFocused: false,
            },
            {
              id: "root/error",
              rect: [2, 1, 2, 1],
              role: "alert",
              label: "Failed",
              liveRegion: "assertive",
              isFocused: false,
            },
          ],
        }),
      ),
    );

    expect(announcer.getAttribute("aria-live")).toBe("assertive");
    expect(announcer.textContent).toBe("Failed\nSaved");

    bridge.stdout.write(
      encoder.encode(
        surfaceRecord({
          version: 2,
          width: 4,
          height: 2,
          styles: [null],
          rows: [[], []],
          accessibilityAnnouncements: [
            { message: "Published", politeness: "assertive" },
            { message: "Queued", politeness: "polite" },
          ],
        }),
      ),
    );

    expect(announcer.getAttribute("aria-live")).toBe("assertive");
    expect(announcer.textContent).toBe("Published\nQueued");

    bridge.stdout.write(
      encoder.encode(
        surfaceRecord({
          version: 2,
          width: 4,
          height: 2,
          styles: [null],
          rows: [[], []],
          accessibilityTree: [
            {
              id: "root/status",
              rect: [0, 1, 2, 1],
              role: "status",
              label: "Saved",
              liveRegion: "polite",
              isFocused: false,
            },
          ],
        }),
      ),
    );

    expect(announcer.textContent).toBe("Published\nQueued");
  } finally {
    dom.restore();
  }
});

test("unknown accessibility tokens preserve rendering and apply consumer defaults", async () => {
  const dom = installFakeDOM();
  try {
    const bridge = new BrowserWASIBridge({
      sceneId: "main",
      columns: 4,
      rows: 1,
    });
    const mount = new FakeElement("div");
    const runtime = new WebHostSceneRuntime({
      mount: mount as unknown as HTMLElement,
      descriptor: { id: "main", title: "Main", isDefault: true },
      style: {
        fontSize: 20,
        fontFamily: "Test Mono",
      },
      bridge,
      onInput: () => {},
    });

    await runtime.mount();
    const context = dom.canvases[0]!.context;
    context.operations = [];

    bridge.stdout.write(
      encoder.encode(transportFixture("web-surface-open-world-tokens")),
    );

    expect(fillTextOperations(context, "A")).toHaveLength(1);
    const tree = childWithClass(
      runtime.terminalMount,
      "webhost-scene__accessibility-tree",
    );
    const status = childWithData(tree, "accessibilityId", "status");
    expect(status.getAttribute("aria-live")).toBeNull();
    const announcer = childWithClass(
      runtime.terminalMount,
      "webhost-scene__accessibility-announcer",
    );
    expect(announcer.getAttribute("aria-live")).toBe("polite");
    expect(announcer.textContent).toBe("Ready");
    expect(runtime.focusPresentation?.semantics).toBe("automatic");
    expect(
      runtime.terminalMount.children.some(
        (child) => child.className === "webhost-scene__diagnostic",
      ),
    ).toBe(false);
  } finally {
    dom.restore();
  }
});

test("runtime decodes surface images once and reuses the cached image", async () => {
  const decodedBlobs: Blob[] = [];
  let closedImages = 0;
  const dom = installFakeDOM({
    createImageBitmap: async (blob) => {
      decodedBlobs.push(blob);
      return {
        imageId: `decoded-${decodedBlobs.length}`,
        close: () => {
          closedImages++;
        },
      };
    },
  });
  try {
    const bridge = new BrowserWASIBridge({
      sceneId: "main",
      columns: 4,
      rows: 2,
    });
    const mount = new FakeElement("div");
    const runtime = new WebHostSceneRuntime({
      mount: mount as unknown as HTMLElement,
      descriptor: { id: "main", title: "Main", isDefault: true },
      style: {
        fontSize: 20,
        fontFamily: "Test Mono",
      },
      bridge,
      onInput: () => {},
    });

    await runtime.mount();

    const canvas = dom.canvases[0]!;
    const context = canvas.context;
    context.operations = [];
    bridge.stdout.write(
      encoder.encode(
        surfaceRecord({
          version: 1,
          width: 4,
          height: 2,
          styles: [null],
          rows: [[[0, "A", 1, 0]], []],
          images: [
            {
              id: "future:test",
              format: "future-format",
              bounds: [0, 0, 1, 1],
              visibleBounds: [0, 0, 1, 1],
              scalingMode: "future-scaling",
              pixelSize: [1, 1],
              dataBase64: "Rk9P",
            },
            {
              id: "png:test",
              format: "png",
              bounds: [1, 0, 2, 2],
              visibleBounds: [1, 0, 1, 2],
              scalingMode: "future-scaling",
              pixelSize: [2, 2],
              dataBase64:
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5L8AAAAASUVORK5CYII=",
            },
            {
              id: "png:test",
              format: "png",
              bounds: [3, 0, 1, 1],
              visibleBounds: [3, 0, 1, 1],
              scalingMode: "stretch",
              pixelSize: [2, 2],
            },
          ],
        }),
      ),
    );
    await flushPromises();

    expect(decodedBlobs).toHaveLength(1);
    expect(fillTextOperations(context, "A").length).toBeGreaterThanOrEqual(1);
    expect(drawImageOperations(context)).toEqual([
      {
        type: "drawImage",
        imageId: "decoded-1",
        x: 10,
        y: 0,
        width: 20,
        height: 54,
      },
      {
        type: "drawImage",
        imageId: "decoded-1",
        x: 30,
        y: 0,
        width: 10,
        height: 27,
      },
    ]);
    expect(context.operations).toContainEqual({
      type: "rect",
      x: 10,
      y: 0,
      width: 10,
      height: 54,
    });
    expect(context.operations).toContainEqual({
      type: "clip",
      path: [["rect", 10, 0, 10, 54]],
    });

    context.operations = [];
    bridge.stdout.write(
      encoder.encode(
        surfaceRecord({
          version: 1,
          width: 4,
          height: 2,
          styles: [null],
          rows: [[], []],
          images: [
            {
              id: "png:test",
              format: "png",
              bounds: [0, 1, 1, 1],
              visibleBounds: [0, 1, 1, 1],
              scalingMode: "stretch",
            },
          ],
        }),
      ),
    );

    expect(decodedBlobs).toHaveLength(1);
    expect(drawImageOperations(context)).toEqual([
      {
        type: "drawImage",
        imageId: "decoded-1",
        x: 0,
        y: 27,
        width: 10,
        height: 27,
      },
    ]);
    runtime.dispose();
    runtime.dispose();
    expect(closedImages).toBe(1);
  } finally {
    dom.restore();
  }
});

test("Canvas decode failure requests WASI image recovery and repaints the same scene", async () => {
  let decodeAttempts = 0;
  const recoveredImage = { imageId: "recovered-image" };
  const dom = installFakeDOM({
    createImageBitmap: async () => {
      decodeAttempts += 1;
      if (decodeAttempts <= 3) {
        throw new Error("decode failed before recovery");
      }
      return recoveredImage;
    },
  });
  try {
    const bridge = new BrowserWASIBridge({
      sceneId: "main",
      columns: 4,
      rows: 2,
    });
    const mount = new FakeElement("div");
    const runtime = new WebHostSceneRuntime({
      mount: mount as unknown as HTMLElement,
      descriptor: { id: "main", title: "Main", isDefault: true },
      style: {
        fontSize: 20,
        fontFamily: "Test Mono",
      },
      bridge,
      onInput: () => {},
    });

    await runtime.mount();
    const controlMessages: string[] = [];
    const unsubscribe = bridge.stdin.subscribe((chunk) => {
      controlMessages.push(decoder.decode(chunk));
      return true;
    });

    bridge.stdout.write(
      encoder.encode(
        surfaceRecord({
          version: 2,
          epoch: 21,
          gen: 1,
          width: 4,
          height: 2,
          styles: [null],
          rows: [[], []],
          images: [
            {
              id: "png:recover-e2e",
              format: "png",
              bounds: [1, 0, 2, 2],
              visibleBounds: [1, 0, 2, 2],
              scalingMode: "stretch",
              dataBase64:
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5L8AAAAASUVORK5CYII=",
            },
          ],
        }),
      ),
    );
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await flushPromises();
    }

    expect(decodeAttempts).toBe(3);
    expect(
      controlMessages.filter((message) => message.startsWith("\u001Eresync:")),
    ).toEqual(['\u001Eresync:{"scope":"images","ids":["png:recover-e2e"]}\n']);
    expect(drawImageOperations(dom.canvases[0]!.context)).toEqual([]);

    bridge.stdout.write(
      encoder.encode(
        surfaceRecord({
          version: 2,
          epoch: 21,
          gen: 2,
          width: 4,
          height: 2,
          styles: [null],
          rows: [[], []],
          images: [
            {
              id: "png:recover-e2e",
              format: "png",
              bounds: [1, 0, 2, 2],
              visibleBounds: [1, 0, 2, 2],
              scalingMode: "stretch",
              dataBase64:
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5L8AAAAASUVORK5CYII=",
            },
          ],
          damage: {
            textRows: [],
            requiresFullTextRepaint: false,
            requiresFullGraphicsReplay: false,
          },
        }),
      ),
    );
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await flushPromises();
    }

    expect(decodeAttempts).toBe(4);
    expect(drawImageOperations(dom.canvases[0]!.context)).toContainEqual({
      type: "drawImage",
      imageId: recoveredImage.imageId,
      x: 10,
      y: 0,
      width: 20,
      height: 54,
    });
    expect(
      controlMessages.filter((message) => message.startsWith("\u001Eresync:")),
    ).toHaveLength(1);

    unsubscribe();
    runtime.dispose();
  } finally {
    dom.restore();
  }
});

test("runtime draws box and block elements procedurally instead of as font glyphs", async () => {
  const dom = installFakeDOM();
  try {
    const bridge = new BrowserWASIBridge({
      sceneId: "main",
      columns: 4,
      rows: 2,
    });
    const mount = new FakeElement("div");
    const runtime = new WebHostSceneRuntime({
      mount: mount as unknown as HTMLElement,
      descriptor: { id: "main", title: "Main", isDefault: true },
      style: {
        fontSize: 20,
        fontFamily: "Test Mono",
      },
      bridge,
      onInput: () => {},
    });

    await runtime.mount();

    const canvas = dom.canvases[0]!;
    const context = canvas.context;
    context.operations = [];
    bridge.stdout.write(
      encoder.encode(
        surfaceRecord({
          version: 1,
          width: 4,
          height: 2,
          styles: [
            null,
            {
              fg: "#EBB33CFF",
            },
          ],
          rows: [
            [
              [0, "┌", 1, 1],
              [1, "─", 1, 1],
              [2, "▄", 1, 1],
              [3, "A", 1, 1],
            ],
          ],
          images: [],
        }),
      ),
    );

    expect(fillTextOperations(context, "┌")).toEqual([]);
    expect(fillTextOperations(context, "─")).toEqual([]);
    expect(fillTextOperations(context, "▄")).toEqual([]);
    expect(fillTextOperations(context, "A")).toHaveLength(1);

    const boxFills = fillRectOperations(context, "#EBB33CFF");
    expect(boxFills).toContainEqual({
      type: "fillRect",
      x: 4.5,
      y: 13,
      width: 5.5,
      height: 1,
      fillStyle: "#EBB33CFF",
      globalAlpha: 1,
    });
    expect(boxFills).toContainEqual({
      type: "fillRect",
      x: 4.5,
      y: 13,
      width: 1,
      height: 14,
      fillStyle: "#EBB33CFF",
      globalAlpha: 1,
    });
    expect(boxFills).toContainEqual({
      type: "fillRect",
      x: 10,
      y: 13,
      width: 5.5,
      height: 1,
      fillStyle: "#EBB33CFF",
      globalAlpha: 1,
    });
    expect(boxFills).toContainEqual({
      type: "fillRect",
      x: 14.5,
      y: 13,
      width: 5.5,
      height: 1,
      fillStyle: "#EBB33CFF",
      globalAlpha: 1,
    });
    expect(boxFills).toContainEqual({
      type: "fillRect",
      x: 20,
      y: 13.5,
      width: 10,
      height: 13.5,
      fillStyle: "#EBB33CFF",
      globalAlpha: 1,
    });
  } finally {
    dom.restore();
  }
});

test("runtime draws rounded box corners with the cell foreground stroke", async () => {
  const dom = installFakeDOM();
  try {
    const bridge = new BrowserWASIBridge({
      sceneId: "main",
      columns: 4,
      rows: 1,
    });
    const mount = new FakeElement("div");
    const runtime = new WebHostSceneRuntime({
      mount: mount as unknown as HTMLElement,
      descriptor: { id: "main", title: "Main", isDefault: true },
      style: {
        fontSize: 20,
        fontFamily: "Test Mono",
      },
      bridge,
      onInput: () => {},
    });

    await runtime.mount();

    const canvas = dom.canvases[0]!;
    const context = canvas.context;
    context.strokeStyle = "#000000";
    context.operations = [];
    bridge.stdout.write(
      encoder.encode(
        surfaceRecord({
          version: 1,
          width: 4,
          height: 1,
          styles: [
            null,
            {
              fg: "#EBB33CFF",
            },
          ],
          rows: [
            [
              [0, "╭", 1, 1],
              [1, "╮", 1, 1],
            ],
          ],
          images: [],
        }),
      ),
    );

    expect(fillTextOperations(context, "╭")).toEqual([]);
    expect(fillTextOperations(context, "╮")).toEqual([]);
    const strokes = context.operations.filter(
      (operation) => operation.type === "stroke",
    );
    expect(strokes).toHaveLength(2);
    expect(
      strokes.every((operation) => operation.strokeStyle === "#EBB33CFF"),
    ).toBe(true);
    expect(strokes.every((operation) => operation.lineWidth === 1)).toBe(true);
    expect(
      strokes.every((operation) => operation.lineDash instanceof Array),
    ).toBe(true);
    expect(
      strokes.every(
        (operation) => (operation.lineDash as unknown[]).length === 0,
      ),
    ).toBe(true);
    expect(
      strokes.every((operation) => {
        const path = operation.path as Array<[string, ...number[]]>;
        return path.some(([command]) => command === "bezierCurveTo");
      }),
    ).toBe(true);
  } finally {
    dom.restore();
  }
});

test("runtime keeps diagnostic stdout visible when output is not a surface frame", async () => {
  const dom = installFakeDOM();
  try {
    const bridge = new BrowserWASIBridge({
      sceneId: "main",
      columns: 4,
      rows: 2,
    });
    const mount = new FakeElement("div");
    const runtime = new WebHostSceneRuntime({
      mount: mount as unknown as HTMLElement,
      descriptor: { id: "main", title: "Main", isDefault: true },
      style: {},
      bridge,
      onInput: () => {},
    });

    await runtime.mount();
    bridge.stdout.write(encoder.encode("legacy output\n"));

    const diagnostic = runtime.terminalMount.children.find(
      (child) => child.className === "webhost-scene__diagnostic",
    );
    expect(diagnostic?.textContent).toBe("legacy output\n");
  } finally {
    dom.restore();
  }
});

test("runtime reports frame diagnostics without rendering them as terminal text", async () => {
  const dom = installFakeDOM();
  try {
    const bridge = new BrowserWASIBridge({
      sceneId: "main",
      columns: 4,
      rows: 2,
    });
    const diagnostics: unknown[] = [];
    const mount = new FakeElement("div");
    const runtime = new WebHostSceneRuntime({
      mount: mount as unknown as HTMLElement,
      descriptor: { id: "main", title: "Main", isDefault: true },
      style: {},
      bridge,
      onInput: () => {},
      onFrameDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    await runtime.mount();
    bridge.stdout.write(
      encoder.encode(
        '\u001EframeDiagnostic:{"format":"swift-tui-frame-diagnostics-v1",' +
          '"header":["frame","total_ms"],"fields":["7","14.20"]}\n',
      ),
    );

    expect(diagnostics).toEqual([
      {
        format: "swift-tui-frame-diagnostics-v1",
        header: ["frame", "total_ms"],
        fields: ["7", "14.20"],
      },
    ]);
    expect(
      runtime.terminalMount.children.some(
        (child) => child.className === "webhost-scene__diagnostic",
      ),
    ).toBe(false);
  } finally {
    dom.restore();
  }
});

test("runtime reports each completed presenter paint with the applied frame", async () => {
  const dom = installFakeDOM();
  try {
    const bridge = new BrowserWASIBridge({
      sceneId: "main",
      columns: 4,
      rows: 2,
    });
    const painted: WebHostSurfacePaintedEvent[] = [];
    const mount = new FakeElement("div");
    const runtime = new WebHostSceneRuntime({
      mount: mount as unknown as HTMLElement,
      descriptor: { id: "main", title: "Main", isDefault: true },
      style: {},
      bridge,
      onInput: () => {},
      onSurfacePainted: (event) => painted.push(event),
    });

    await runtime.mount();
    const paintsBefore = runtime.paintStatistics.paints;
    const eventsBefore = painted.length;
    const before = performance.now();
    bridge.stdout.write(
      encoder.encode(
        surfaceRecord({
          version: 1,
          width: 4,
          height: 2,
          styles: [null],
          rows: [[[0, "A", 1, 0]], []],
          images: [],
        }),
      ),
    );

    // One event per paint, carrying the decoded frame the presenter applied.
    expect(runtime.paintStatistics.paints).toBe(paintsBefore + 1);
    expect(painted).toHaveLength(eventsBefore + 1);
    const event = painted.at(-1)!;
    expect(event.frame?.width).toBe(4);
    expect(event.frame?.rows[0]).toEqual([[0, "A", 1, 0]]);
    expect(event.coalescedFrameCount).toBe(0);
    expect(event.paintedAt).toBeGreaterThanOrEqual(before);
    expect(event.paintedAt).toBeLessThanOrEqual(performance.now());
  } finally {
    dom.restore();
  }
});

test("coalesced paints report the newest frame and the superseded count", async () => {
  const dom = installFakeDOM();
  try {
    const bridge = new BrowserWASIBridge({
      sceneId: "main",
      columns: 4,
      rows: 2,
    });
    const frames = new ManualAnimationFrameScheduler();
    const painted: WebHostSurfacePaintedEvent[] = [];
    const mount = new FakeElement("div");
    const runtime = new WebHostSceneRuntime({
      mount: mount as unknown as HTMLElement,
      descriptor: { id: "main", title: "Main", isDefault: true },
      style: {},
      bridge,
      onInput: () => {},
      paintScheduling: frames,
      onSurfacePainted: (event) => painted.push(event),
    });

    await runtime.mount();
    frames.tick();
    painted.length = 0;
    for (const glyph of ["A", "B"]) {
      bridge.stdout.write(
        encoder.encode(
          surfaceRecord({
            version: 1,
            width: 4,
            height: 2,
            styles: [null],
            rows: [[[0, glyph, 1, 0]], []],
            images: [],
          }),
        ),
      );
    }

    // Presented frames stay unpainted until the animation frame; the paint
    // then reports the newest frame once and counts the frame it superseded.
    expect(painted).toHaveLength(0);
    frames.tick();
    expect(painted).toHaveLength(1);
    expect(painted[0]!.frame?.rows[0]).toEqual([[0, "B", 1, 0]]);
    expect(painted[0]!.coalescedFrameCount).toBe(1);
  } finally {
    dom.restore();
  }
});

test("a coarse-pointer client declares scroll panning and tracks paradigm changes", async () => {
  const coarsePointer = new FakeMediaQueryList(true);
  const dom = installFakeDOM({ coarsePointer });
  try {
    const declarations: boolean[] = [];
    const mount = new FakeElement("div");
    const runtime = new WebHostSceneRuntime({
      mount: mount as unknown as HTMLElement,
      descriptor: { id: "main", title: "Main", isDefault: true },
      style: {},
      onInput: () => {},
      bridge: {
        bindOutput: () => {},
        resize: () => {},
        updateRenderStyle: () => {},
        sendInput: () => {},
        updatePointerCapabilities: (supportsScrollPanning) => {
          declarations.push(supportsScrollPanning);
        },
        dispose: () => {},
      },
    });
    await runtime.mount();

    // A touch-primary client says so at mount; the app has no other way to
    // know, and one page bundle serves both paradigms.
    expect(declarations).toEqual([true]);

    // Docking a mouse flips the primary pointer. Only the change is sent.
    coarsePointer.setMatches(false);
    coarsePointer.setMatches(false);
    expect(declarations).toEqual([true, false]);

    // A real press is stronger evidence than the media query: this is the
    // pointer actually in use, not merely the primary one.
    runtime.terminalMount.dispatch(
      "pointerdown",
      pointerEvent({
        button: 0,
        buttons: 1,
        pointerId: 3,
        pointerType: "touch",
      }),
    );
    expect(declarations).toEqual([true, false, true]);

    // A pointer type the runtime cannot classify (pen, or an embedder that
    // omits it) leaves the last answer standing rather than guessing.
    runtime.terminalMount.dispatch(
      "pointerdown",
      pointerEvent({
        button: 0,
        buttons: 1,
        pointerId: 4,
        pointerType: "pen",
      }),
    );
    expect(declarations).toEqual([true, false, true]);
  } finally {
    dom.restore();
  }
});

test("a desktop client declares nothing, because absence already means desktop", async () => {
  const dom = installFakeDOM({ coarsePointer: new FakeMediaQueryList(false) });
  try {
    const declarations: boolean[] = [];
    const mount = new FakeElement("div");
    const runtime = new WebHostSceneRuntime({
      mount: mount as unknown as HTMLElement,
      descriptor: { id: "main", title: "Main", isDefault: true },
      style: {},
      onInput: () => {},
      bridge: {
        bindOutput: () => {},
        resize: () => {},
        updateRenderStyle: () => {},
        sendInput: () => {},
        updatePointerCapabilities: (supportsScrollPanning) => {
          declarations.push(supportsScrollPanning);
        },
        dispose: () => {},
      },
    });
    await runtime.mount();

    runtime.terminalMount.dispatch(
      "pointerdown",
      pointerEvent({
        button: 0,
        buttons: 1,
        pointerId: 3,
        pointerType: "mouse",
      }),
    );
    expect(declarations).toEqual([]);
  } finally {
    dom.restore();
  }
});

test("runtime maps browser input events to web-surface messages", async () => {
  const dom = installFakeDOM();
  try {
    const inputs: string[] = [];
    const mount = new FakeElement("div");
    const runtime = new WebHostSceneRuntime({
      mount: mount as unknown as HTMLElement,
      descriptor: { id: "main", title: "Main", isDefault: true },
      style: { fontSize: 20 },
      onInput: (chunk) => {
        inputs.push(decoder.decode(chunk));
      },
      // This test checks wheel-input encoding, not chaining: force capture so
      // the wheel is always forwarded regardless of published scroll regions.
      wheelMode: "capture",
    });

    await runtime.mount();
    runtime.resize(10, 4);

    runtime.terminalMount.dispatch("keydown", {
      key: "a",
      shiftKey: true,
      altKey: false,
      ctrlKey: true,
      metaKey: false,
      isComposing: false,
      preventDefault() {},
    });
    runtime.terminalMount.dispatch("paste", {
      clipboardData: {
        getData: () => "hello world",
      },
      preventDefault() {},
    });
    runtime.terminalMount.dispatch(
      "pointerdown",
      pointerEvent({
        button: 0,
        buttons: 1,
        clientX: 25,
        clientY: 10,
        pointerId: 7,
      }),
    );
    runtime.terminalMount.dispatch(
      "pointermove",
      pointerEvent({
        buttons: 1,
        clientX: 35,
        clientY: 30,
        pointerId: 7,
      }),
    );
    runtime.terminalMount.dispatch("wheel", {
      clientX: 35,
      clientY: 30,
      deltaX: 0,
      deltaY: 20,
      shiftKey: false,
      altKey: true,
      ctrlKey: false,
      preventDefault() {},
    });

    expect(inputs).toEqual([
      "\u001Ekey:character:a:5\n",
      "\u001Epaste:hello%20world\n",
      "\u001Emouse:down:2.5:0.37037037037037035:primary:0:0:0\n",
      "\u001Emouse:dragged:3.5:1.1111111111111112:primary:0:0:0\n",
      "\u001Emouse:scrolled:3.5:1.1111111111111112:none:0:1:2\n",
    ]);
  } finally {
    dom.restore();
  }
});

test("runtime can run as a passive embed without stealing focus or wheel scroll", async () => {
  const dom = installFakeDOM();
  try {
    const inputs: string[] = [];
    const bridge = new BrowserWASIBridge({
      sceneId: "main",
      columns: 4,
      rows: 2,
    });
    const mount = new FakeElement("div");
    const runtime = new WebHostSceneRuntime({
      mount: mount as unknown as HTMLElement,
      descriptor: { id: "main", title: "Main", isDefault: true },
      style: { fontSize: 20 },
      bridge,
      onInput: (chunk) => {
        inputs.push(decoder.decode(chunk));
      },
      synchronizeAccessibilityFocus: false,
      captureWheelInput: false,
    });

    await runtime.mount();
    bridge.stdout.write(
      encoder.encode(
        surfaceRecord({
          version: 2,
          width: 4,
          height: 2,
          styles: [null],
          rows: [[], []],
          accessibilityTree: [
            {
              id: "root/button",
              rect: [0, 0, 2, 1],
              role: "button",
              label: "Save",
              isFocused: true,
            },
          ],
        }),
      ),
    );

    const tree = childWithClass(
      runtime.terminalMount,
      "webhost-scene__accessibility-tree",
    );
    const button = childWithData(tree, "accessibilityId", "root/button");
    let wheelPrevented = false;

    runtime.terminalMount.dispatch("wheel", {
      clientX: 35,
      clientY: 30,
      deltaX: 0,
      deltaY: 20,
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      preventDefault() {
        wheelPrevented = true;
      },
    });

    expect(button.focused).toBe(false);
    expect(button.lastFocusOptions).toBeUndefined();
    expect(inputs).toEqual([]);
    expect(wheelPrevented).toBe(false);
  } finally {
    dom.restore();
  }
});

test("chain mode captures the wheel when a region under the pointer can scroll", async () => {
  const dom = installFakeDOM();
  try {
    // Region covers the whole 4x2 surface; content is taller than the viewport
    // and scrolled to the top, so a downward wheel has headroom.
    const result = await wheelScenario({
      wheelMode: "chain",
      scrollRegions: [
        { id: "list", rect: [0, 0, 4, 2], offset: [0, 0], content: [4, 10] },
      ],
      wheel: { clientX: 5, clientY: 5, deltaY: 20 },
    });
    expect(result.captured).toBe(true);
    expect(result.wheelPrevented).toBe(true);
    expect(result.overscrollBehavior).toBe("auto");
  } finally {
    dom.restore();
  }
});

test("chain mode lets the wheel fall through at the region's scroll edge", async () => {
  const dom = installFakeDOM();
  try {
    // Same region, but scrolled to the bottom (offset.y == maxY == 10 - 2),
    // so a further downward wheel has no headroom and must chain to the page.
    const result = await wheelScenario({
      wheelMode: "chain",
      scrollRegions: [
        { id: "list", rect: [0, 0, 4, 2], offset: [0, 8], content: [4, 10] },
      ],
      wheel: { clientX: 5, clientY: 5, deltaY: 20 },
    });
    expect(result.captured).toBe(false);
    expect(result.wheelPrevented).toBe(false);
    expect(result.overscrollBehavior).toBe("auto");
  } finally {
    dom.restore();
  }
});

test("chain mode captures an upward wheel when scrolled away from the top", async () => {
  const dom = installFakeDOM();
  try {
    // At the bottom edge, downward chains but upward still has headroom.
    const result = await wheelScenario({
      wheelMode: "chain",
      scrollRegions: [
        { id: "list", rect: [0, 0, 4, 2], offset: [0, 8], content: [4, 10] },
      ],
      wheel: { clientX: 5, clientY: 5, deltaY: -20 },
    });
    expect(result.captured).toBe(true);
    expect(result.wheelPrevented).toBe(true);
    expect(result.overscrollBehavior).toBe("auto");
  } finally {
    dom.restore();
  }
});

test("chain mode falls through when the pointer is outside every scroll region", async () => {
  const dom = installFakeDOM();
  try {
    // Region only covers the right half (cells x>=2); wheel at cell (0,0).
    const result = await wheelScenario({
      wheelMode: "chain",
      scrollRegions: [
        { id: "list", rect: [2, 0, 2, 2], offset: [0, 0], content: [2, 10] },
      ],
      wheel: { clientX: 5, clientY: 5, deltaY: 20 },
    });
    expect(result.captured).toBe(false);
    expect(result.wheelPrevented).toBe(false);
    expect(result.overscrollBehavior).toBe("auto");
  } finally {
    dom.restore();
  }
});

test("chain mode falls through when the scene publishes no scroll regions", async () => {
  const dom = installFakeDOM();
  try {
    const result = await wheelScenario({
      wheelMode: "chain",
      wheel: { clientX: 5, clientY: 5, deltaY: 20 },
    });
    expect(result.captured).toBe(false);
    expect(result.wheelPrevented).toBe(false);
    expect(result.overscrollBehavior).toBe("auto");
  } finally {
    dom.restore();
  }
});

test("capture mode always eats the wheel even without scroll regions", async () => {
  const dom = installFakeDOM();
  try {
    const result = await wheelScenario({
      wheelMode: "capture",
      wheel: { clientX: 5, clientY: 5, deltaY: 20 },
    });
    expect(result.captured).toBe(true);
    expect(result.wheelPrevented).toBe(true);
    expect(result.overscrollBehavior).toBe("contain");
  } finally {
    dom.restore();
  }
});

test("legacy captureWheelInput:true maps to capture mode", async () => {
  const dom = installFakeDOM();
  try {
    const result = await wheelScenario({
      captureWheelInput: true,
      wheel: { clientX: 5, clientY: 5, deltaY: 20 },
    });
    expect(result.captured).toBe(true);
    expect(result.wheelPrevented).toBe(true);
    expect(result.overscrollBehavior).toBe("contain");
  } finally {
    dom.restore();
  }
});

test("legacy captureWheelInput:false maps to passive mode", async () => {
  const dom = installFakeDOM();
  try {
    const result = await wheelScenario({
      captureWheelInput: false,
      // A scrollable region is published, but passive never captures.
      scrollRegions: [
        { id: "list", rect: [0, 0, 4, 2], offset: [0, 0], content: [4, 10] },
      ],
      wheel: { clientX: 5, clientY: 5, deltaY: 20 },
    });
    expect(result.captured).toBe(false);
    expect(result.wheelPrevented).toBe(false);
    expect(result.overscrollBehavior).toBe("auto");
  } finally {
    dom.restore();
  }
});

test("default wheel mode is chain: captures over a scrollable region", async () => {
  const dom = installFakeDOM();
  try {
    // Neither wheelMode nor captureWheelInput set — the runtime must default to
    // "chain", so the wheel is captured while the region has headroom.
    const result = await wheelScenario({
      scrollRegions: [
        { id: "list", rect: [0, 0, 4, 2], offset: [0, 0], content: [4, 10] },
      ],
      wheel: { clientX: 5, clientY: 5, deltaY: 20 },
    });
    expect(result.captured).toBe(true);
    expect(result.wheelPrevented).toBe(true);
    expect(result.overscrollBehavior).toBe("auto");
  } finally {
    dom.restore();
  }
});

test("default wheel mode is chain: page scrolls with no scrollable region", async () => {
  const dom = installFakeDOM();
  try {
    // No mode set and no scroll regions published — the default "chain" mode
    // must let the wheel fall through so the page scrolls.
    const result = await wheelScenario({
      wheel: { clientX: 5, clientY: 5, deltaY: 20 },
    });
    expect(result.captured).toBe(false);
    expect(result.wheelPrevented).toBe(false);
    expect(result.overscrollBehavior).toBe("auto");
  } finally {
    dom.restore();
  }
});

test("runtime preserves pointer movement within one cell", async () => {
  const dom = installFakeDOM();
  try {
    const inputs: string[] = [];
    const mount = new FakeElement("div");
    const runtime = new WebHostSceneRuntime({
      mount: mount as unknown as HTMLElement,
      descriptor: { id: "main", title: "Main", isDefault: true },
      style: { fontSize: 20 },
      onInput: (chunk) => {
        inputs.push(decoder.decode(chunk));
      },
    });

    await runtime.mount();
    runtime.resize(10, 4);

    runtime.terminalMount.dispatch(
      "pointermove",
      pointerEvent({
        buttons: 1,
        clientX: 21,
        clientY: 27,
        pointerId: 7,
      }),
    );
    runtime.terminalMount.dispatch(
      "pointermove",
      pointerEvent({
        buttons: 1,
        clientX: 27,
        clientY: 27,
        pointerId: 7,
      }),
    );

    expect(inputs).toEqual([
      "\u001Emouse:dragged:2.1:1:primary:0:0:0\n",
      "\u001Emouse:dragged:2.7:1:primary:0:0:0\n",
    ]);
  } finally {
    dom.restore();
  }
});

test("runtime completes captured drags when pointerup lands outside the grid", async () => {
  const dom = installFakeDOM();
  try {
    const inputs: string[] = [];
    const mount = new FakeElement("div");
    const runtime = new WebHostSceneRuntime({
      mount: mount as unknown as HTMLElement,
      descriptor: { id: "main", title: "Main", isDefault: true },
      style: { fontSize: 20 },
      onInput: (chunk) => {
        inputs.push(decoder.decode(chunk));
      },
    });

    await runtime.mount();
    runtime.resize(10, 4);

    runtime.terminalMount.dispatch(
      "pointerdown",
      pointerEvent({
        button: 0,
        buttons: 1,
        clientX: 25,
        clientY: 10,
        pointerId: 7,
      }),
    );
    runtime.terminalMount.dispatch(
      "pointermove",
      pointerEvent({
        buttons: 1,
        clientX: 35,
        clientY: 30,
        pointerId: 7,
      }),
    );
    runtime.terminalMount.dispatch(
      "pointerup",
      pointerEvent({
        button: 0,
        buttons: 0,
        clientX: 125,
        clientY: 30,
        pointerId: 7,
      }),
    );

    expect(inputs).toEqual([
      "\u001Emouse:down:2.5:0.37037037037037035:primary:0:0:0\n",
      "\u001Emouse:dragged:3.5:1.1111111111111112:primary:0:0:0\n",
      "\u001Emouse:up:12.5:1.1111111111111112:primary:0:0:0\n",
    ]);
  } finally {
    dom.restore();
  }
});

test("clicking a hyperlink cell opens its target through the handler", async () => {
  const dom = installFakeDOM();
  try {
    const opened: string[] = [];
    const inputs: string[] = [];
    const bridge = new BrowserWASIBridge({
      sceneId: "main",
      columns: 4,
      rows: 2,
    });
    const mount = new FakeElement("div");
    const runtime = new WebHostSceneRuntime({
      mount: mount as unknown as HTMLElement,
      descriptor: { id: "main", title: "Main", isDefault: true },
      style: { fontSize: 20 },
      bridge,
      onInput: (chunk) => {
        inputs.push(decoder.decode(chunk));
      },
      onOpenHyperlink: (url) => {
        opened.push(url);
      },
    });

    await runtime.mount();
    bridge.stdout.write(
      encoder.encode(
        surfaceRecord({
          version: 2,
          width: 4,
          height: 2,
          styles: [null],
          rows: [
            [
              [0, "a", 1, 0],
              [1, "b", 1, 0],
              [2, "c", 1, 0],
            ],
            [],
          ],
          links: [[0, [[0, 2, 0]]]],
          linkTargets: ["https://a.example/docs"],
        }),
      ),
    );

    // Click (down + up) on the linked run opens its target.
    runtime.terminalMount.dispatch(
      "pointerdown",
      pointerEvent({
        button: 0,
        buttons: 1,
        clientX: 5,
        clientY: 5,
        pointerId: 7,
      }),
    );
    runtime.terminalMount.dispatch(
      "pointerup",
      pointerEvent({
        button: 0,
        buttons: 0,
        clientX: 5,
        clientY: 5,
        pointerId: 7,
      }),
    );
    expect(opened).toEqual(["https://a.example/docs"]);

    // A drag that leaves the link before release does not open it.
    runtime.terminalMount.dispatch(
      "pointerdown",
      pointerEvent({
        button: 0,
        buttons: 1,
        clientX: 5,
        clientY: 5,
        pointerId: 7,
      }),
    );
    runtime.terminalMount.dispatch(
      "pointerup",
      pointerEvent({
        button: 0,
        buttons: 0,
        clientX: 25,
        clientY: 5,
        pointerId: 7,
      }),
    );
    // Neither does a click on an unlinked cell.
    runtime.terminalMount.dispatch(
      "pointerdown",
      pointerEvent({
        button: 0,
        buttons: 1,
        clientX: 25,
        clientY: 5,
        pointerId: 7,
      }),
    );
    runtime.terminalMount.dispatch(
      "pointerup",
      pointerEvent({
        button: 0,
        buttons: 0,
        clientX: 25,
        clientY: 5,
        pointerId: 7,
      }),
    );
    expect(opened).toEqual(["https://a.example/docs"]);

    // The app still received every pointer message.
    expect(
      inputs.filter((message) => message.includes("mouse:down")),
    ).toHaveLength(3);
    expect(
      inputs.filter((message) => message.includes("mouse:up")),
    ).toHaveLength(3);
  } finally {
    dom.restore();
  }
});

test("pointer over a hyperlink shows a pointer cursor", async () => {
  const dom = installFakeDOM();
  try {
    const bridge = new BrowserWASIBridge({
      sceneId: "main",
      columns: 4,
      rows: 2,
    });
    const mount = new FakeElement("div");
    const runtime = new WebHostSceneRuntime({
      mount: mount as unknown as HTMLElement,
      descriptor: { id: "main", title: "Main", isDefault: true },
      style: { fontSize: 20 },
      bridge,
      onInput: () => {},
    });

    await runtime.mount();
    bridge.stdout.write(
      encoder.encode(
        surfaceRecord({
          version: 2,
          width: 4,
          height: 2,
          styles: [null],
          rows: [[[0, "a", 1, 0]], []],
          links: [[0, [[0, 1, 0]]]],
          linkTargets: ["https://a.example"],
        }),
      ),
    );

    runtime.terminalMount.dispatch(
      "pointermove",
      pointerEvent({
        buttons: 0,
        clientX: 5,
        clientY: 5,
        pointerId: 7,
      }),
    );
    expect(runtime.terminalMount.style.cursor).toBe("pointer");

    runtime.terminalMount.dispatch(
      "pointermove",
      pointerEvent({
        buttons: 0,
        clientX: 25,
        clientY: 5,
        pointerId: 7,
      }),
    );
    expect(runtime.terminalMount.style.cursor).toBe("");
  } finally {
    dom.restore();
  }
});

test("accessibility nodes marked hidden stay out of the ARIA tree", async () => {
  const dom = installFakeDOM();
  try {
    const bridge = new BrowserWASIBridge({
      sceneId: "main",
      columns: 4,
      rows: 2,
    });
    const mount = new FakeElement("div");
    const runtime = new WebHostSceneRuntime({
      mount: mount as unknown as HTMLElement,
      descriptor: { id: "main", title: "Main", isDefault: true },
      style: { fontSize: 20 },
      bridge,
      onInput: () => {},
    });

    await runtime.mount();
    bridge.stdout.write(
      encoder.encode(
        surfaceRecord({
          version: 2,
          width: 4,
          height: 2,
          styles: [null],
          rows: [[], []],
          accessibilityTree: [
            { id: "root", rect: [0, 0, 4, 2], role: "group", isFocused: false },
            {
              id: "root/ghost",
              parentId: "root",
              rect: [0, 0, 1, 1],
              role: "button",
              label: "Ghost",
              hidden: true,
              isFocused: false,
            },
            {
              id: "root/visible",
              parentId: "root",
              rect: [1, 0, 1, 1],
              role: "button",
              label: "Visible",
              isFocused: false,
            },
          ],
        }),
      ),
    );

    const tree = childWithClass(
      runtime.terminalMount,
      "webhost-scene__accessibility-tree",
    );
    const root = childWithData(tree, "accessibilityId", "root");
    expect(
      root.children.some(
        (child) => child.dataset["accessibilityId"] === "root/visible",
      ),
    ).toBe(true);
    expect(
      root.children.some(
        (child) => child.dataset["accessibilityId"] === "root/ghost",
      ),
    ).toBe(false);
  } finally {
    dom.restore();
  }
});

test("runtime exposes focus presentation and preferred grid size", async () => {
  const dom = installFakeDOM();
  try {
    const bridge = new BrowserWASIBridge({
      sceneId: "main",
      columns: 4,
      rows: 2,
    });
    const mount = new FakeElement("div");
    const runtime = new WebHostSceneRuntime({
      mount: mount as unknown as HTMLElement,
      descriptor: { id: "main", title: "Main", isDefault: true },
      style: { fontSize: 20 },
      bridge,
      onInput: () => {},
    });

    await runtime.mount();
    expect(runtime.focusPresentation).toBeUndefined();
    expect(runtime.preferredGridSize).toBeUndefined();

    bridge.stdout.write(
      encoder.encode(
        surfaceRecord({
          version: 2,
          width: 4,
          height: 2,
          styles: [null],
          rows: [[], []],
          focusPresentation: {
            focusedIdentity: "root/field",
            semantics: "edit",
            prefersTextInput: true,
            hasFocusedRegion: true,
          },
          preferredGridWidth: 9,
          preferredGridHeight: 8,
        }),
      ),
    );

    expect(runtime.focusPresentation).toEqual({
      focusedIdentity: "root/field",
      semantics: "edit",
      prefersTextInput: true,
      hasFocusedRegion: true,
    });
    expect(runtime.preferredGridSize).toEqual({ width: 9, height: 8 });

    bridge.stdout.write(
      encoder.encode(
        surfaceRecord({
          version: 2,
          width: 4,
          height: 2,
          styles: [null],
          rows: [[], []],
          focusPresentation: {
            focusedIdentity: "root/future",
            semantics: "future-focus",
            prefersTextInput: false,
            hasFocusedRegion: true,
          },
        }),
      ),
    );

    expect(runtime.focusPresentation).toEqual({
      focusedIdentity: "root/future",
      semantics: "automatic",
      prefersTextInput: false,
      hasFocusedRegion: true,
    });
  } finally {
    dom.restore();
  }
});

// MARK: - Animation-frame paint batching (STUI-143)

/**
 * Mounts a 4x2 canvas runtime whose paints wait for the returned manual
 * animation-frame clock. Cell geometry under the fake DOM is 10x27 px.
 */
async function mountBatchedRuntime(
  options: {
    dom: ReturnType<typeof installFakeDOM>;
    onOpenHyperlink?: (url: string) => void;
    onInput?: (chunk: Uint8Array) => void;
  } = { dom: installFakeDOM() },
): Promise<{
  runtime: WebHostSceneRuntime;
  bridge: BrowserWASIBridge;
  clock: ManualAnimationFrameScheduler;
  context: RecordingCanvasContext;
  present(frame: Record<string, unknown>): void;
}> {
  const clock = new ManualAnimationFrameScheduler();
  const bridge = new BrowserWASIBridge({
    sceneId: "main",
    columns: 4,
    rows: 2,
  });
  const mount = new FakeElement("div");
  const runtime = new WebHostSceneRuntime({
    mount: mount as unknown as HTMLElement,
    descriptor: { id: "main", title: "Main", isDefault: true },
    style: {
      fontSize: 20,
      fontFamily: "Test Mono",
      theme: { background: "#101820" },
    },
    bridge,
    onInput: options.onInput ?? (() => {}),
    onOpenHyperlink: options.onOpenHyperlink,
    synchronizeAccessibilityFocus: false,
    paintScheduling: clock,
  });
  await runtime.mount();
  const context = options.dom.canvases[0]!.context;
  return {
    runtime,
    bridge,
    clock,
    context,
    present: (frame) => {
      bridge.stdout.write(
        encoder.encode(
          surfaceRecord({
            version: 2,
            epoch: 1,
            width: 4,
            height: 2,
            styles: [null],
            ...frame,
          }),
        ),
      );
    },
  };
}

test("a burst of frames within one animation frame paints once, as the newest frame", async () => {
  const dom = installFakeDOM();
  try {
    const { runtime, clock, context, present } = await mountBatchedRuntime({
      dom,
    });
    // Mounting paints the empty surface synchronously; a first frame waits.
    const mountPaints = runtime.paintStatistics.paints;
    context.operations = [];

    present({ gen: 1, rows: [[[0, "A", 1, 0]], []] });
    present({
      gen: 2,
      rows: [[[0, "B", 1, 0]], []],
      damage: {
        textRows: [[0, [[0, 1]]]],
        requiresFullTextRepaint: false,
        requiresFullGraphicsReplay: false,
      },
    });
    present({
      gen: 3,
      rows: [[[0, "C", 1, 0]], [[3, "z", 1, 0]]],
      damage: {
        textRows: [[1, [[3, 4]]]],
        requiresFullTextRepaint: false,
        requiresFullGraphicsReplay: false,
      },
    });

    expect(context.operations).toEqual([]);
    expect(clock.scheduled).toBe(1);
    expect(runtime.paintStatistics).toMatchObject({
      presentedFrames: 3,
      paints: mountPaints,
      coalescedFrames: 2,
      pending: true,
    });

    clock.tick();
    // Exactly one paint, and it shows the newest frame only: never A or B.
    expect(runtime.paintStatistics).toMatchObject({
      presentedFrames: 3,
      paints: mountPaints + 1,
      coalescedFrames: 2,
      pending: false,
    });
    expect(fillTextOperations(context, "A")).toEqual([]);
    expect(fillTextOperations(context, "B")).toEqual([]);
    expect(fillTextOperations(context, "C")).toHaveLength(1);
    expect(fillTextOperations(context, "z")).toHaveLength(1);
    // The first frame after mount has no baseline, so the paint is full.
    expect(context.operations).toContainEqual({
      type: "clearRect",
      x: 0,
      y: 0,
      width: 100,
      height: 108,
    });

    // With a painted baseline, the next burst repaints only the union of its damage.
    context.operations = [];
    present({
      gen: 4,
      rows: [[[0, "D", 1, 0]], [[3, "z", 1, 0]]],
      damage: {
        textRows: [[0, [[0, 1]]]],
        requiresFullTextRepaint: false,
        requiresFullGraphicsReplay: false,
      },
    });
    present({
      gen: 5,
      rows: [[[0, "D", 1, 0]], [[3, "y", 1, 0]]],
      damage: {
        textRows: [[1, [[3, 4]]]],
        requiresFullTextRepaint: false,
        requiresFullGraphicsReplay: false,
      },
    });
    clock.tick();
    expect(
      context.operations.filter((operation) => operation.type === "clearRect"),
    ).toEqual([
      { type: "clearRect", x: 0, y: 0, width: 10, height: 27 },
      { type: "clearRect", x: 30, y: 27, width: 10, height: 27 },
    ]);
    expect(fillTextOperations(context, "D")).toHaveLength(1);
    expect(fillTextOperations(context, "y")).toHaveLength(1);
    expect(clock.requests).toBe(2);
  } finally {
    dom.restore();
  }
});

test("pointer geometry and frame getters follow the newest frame before it is painted", async () => {
  const dom = installFakeDOM();
  const opened: string[] = [];
  try {
    const { runtime, clock, context, present } = await mountBatchedRuntime({
      dom,
      onOpenHyperlink: (url) => {
        opened.push(url);
      },
    });
    present({
      gen: 1,
      rows: [[[0, "a", 1, 0]], []],
      links: [[0, [[0, 1, 0]]]],
      linkTargets: ["https://a.example/row0"],
      preferredGridWidth: 10,
      preferredGridHeight: 3,
    });
    clock.tick();
    expect(fillTextOperations(context, "a")).toHaveLength(1);

    // The link moves to row 1; the paint is still pending.
    context.operations = [];
    present({
      gen: 2,
      rows: [[], [[0, "b", 1, 0]]],
      links: [[1, [[0, 1, 0]]]],
      linkTargets: ["https://b.example/row1"],
      preferredGridWidth: 12,
      preferredGridHeight: 5,
      focusPresentation: {
        focusedIdentity: "root/b",
        semantics: "automatic",
        prefersTextInput: true,
        hasFocusedRegion: true,
      },
    });
    expect(context.operations).toEqual([]);

    expect(runtime.preferredGridSize).toEqual({ width: 12, height: 5 });
    expect(runtime.focusPresentation?.focusedIdentity).toBe("root/b");

    // Clicking where the link *was* opens nothing; clicking where the app now
    // has it opens the new target — the app already lives in frame 2.
    runtime.terminalMount.dispatch(
      "pointerdown",
      pointerEvent({
        button: 0,
        buttons: 1,
        clientX: 5,
        clientY: 5,
        pointerId: 1,
      }),
    );
    runtime.terminalMount.dispatch(
      "pointerup",
      pointerEvent({
        button: 0,
        buttons: 0,
        clientX: 5,
        clientY: 5,
        pointerId: 1,
      }),
    );
    expect(opened).toEqual([]);
    runtime.terminalMount.dispatch(
      "pointerdown",
      pointerEvent({
        button: 0,
        buttons: 1,
        clientX: 5,
        clientY: 30,
        pointerId: 1,
      }),
    );
    runtime.terminalMount.dispatch(
      "pointerup",
      pointerEvent({
        button: 0,
        buttons: 0,
        clientX: 5,
        clientY: 30,
        pointerId: 1,
      }),
    );
    expect(opened).toEqual(["https://b.example/row1"]);

    clock.tick();
    expect(fillTextOperations(context, "b")).toHaveLength(1);
  } finally {
    dom.restore();
  }
});

test("the ARIA sidecar advances with the paint and loses no coalesced announcement", async () => {
  const dom = installFakeDOM();
  try {
    const { runtime, clock, present } = await mountBatchedRuntime({ dom });
    const announcer = childWithClass(
      runtime.terminalMount,
      "webhost-scene__accessibility-announcer",
    );
    const tree = childWithClass(
      runtime.terminalMount,
      "webhost-scene__accessibility-tree",
    );
    const node = (label: string) => [
      {
        id: "root",
        rect: [0, 0, 4, 2] as [number, number, number, number],
        role: "status",
        label,
        isFocused: false,
      },
    ];

    present({
      gen: 1,
      rows: [[], []],
      accessibilityTree: node("one"),
      accessibilityAnnouncements: [{ message: "first", politeness: "polite" }],
    });
    clock.tick();
    expect(
      childWithData(tree, "accessibilityId", "root").getAttribute("aria-label"),
    ).toBe("one");
    expect(announcer.textContent).toBe("first");

    present({
      gen: 2,
      rows: [[], []],
      accessibilityTree: node("two"),
      accessibilityAnnouncements: [{ message: "second", politeness: "polite" }],
    });
    present({
      gen: 3,
      rows: [[], []],
      accessibilityTree: node("three"),
      accessibilityAnnouncements: [
        { message: "third", politeness: "assertive" },
        { message: "fourth", politeness: "polite" },
      ],
    });
    // Nothing moved yet: the sidecar describes what is on screen.
    expect(
      childWithData(tree, "accessibilityId", "root").getAttribute("aria-label"),
    ).toBe("one");
    expect(announcer.textContent).toBe("first");

    clock.tick();
    expect(
      childWithData(tree, "accessibilityId", "root").getAttribute("aria-label"),
    ).toBe("three");
    // Assertive first, then polite, each group in transport order.
    expect(announcer.getAttribute("aria-live")).toBe("assertive");
    expect(announcer.textContent).toBe("third\nsecond\nfourth");

    // A repaint without a new frame re-announces nothing.
    runtime.resize(4, 2);
    expect(announcer.textContent).toBe("third\nsecond\nfourth");
  } finally {
    dom.restore();
  }
});

test("an image payload carried only by a coalesced frame decodes without a recovery request", async () => {
  let decodeAttempts = 0;
  const decoded = { imageId: "carried" };
  const dom = installFakeDOM({
    createImageBitmap: async () => {
      decodeAttempts += 1;
      return decoded;
    },
  });
  try {
    const { runtime, bridge, clock, context, present } =
      await mountBatchedRuntime({ dom });
    const controlMessages: string[] = [];
    const unsubscribe = bridge.stdin.subscribe((chunk) => {
      controlMessages.push(decoder.decode(chunk));
      return true;
    });
    const onePixelPNG =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5L8AAAAASUVORK5CYII=";
    const image = {
      id: "png:carried",
      format: "png",
      bounds: [1, 0, 2, 2],
      visibleBounds: [1, 0, 2, 2],
      scalingMode: "stretch",
    };
    present({
      gen: 1,
      rows: [[], []],
      images: [{ ...image, dataBase64: onePixelPNG }],
    });
    // The content-addressed repeat omits the bytes the sender already emitted.
    present({
      gen: 2,
      rows: [[], []],
      images: [image],
      damage: {
        textRows: [],
        requiresFullTextRepaint: false,
        requiresFullGraphicsReplay: false,
      },
    });
    clock.tick();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await flushPromises();
    }

    expect(decodeAttempts).toBe(1);
    expect(
      controlMessages.filter((message) => message.startsWith("\u001Eresync:")),
    ).toEqual([]);
    // Decode completion asks for a repaint through the scheduler, not now.
    expect(drawImageOperations(context)).toEqual([]);
    expect(runtime.paintStatistics.pending).toBe(true);
    clock.tick();
    expect(drawImageOperations(context)).toHaveLength(1);
    expect(runtime.paintStatistics.pending).toBe(false);
    unsubscribe();
  } finally {
    dom.restore();
  }
});

test("dispose cancels a pending paint and later frames are ignored", async () => {
  const dom = installFakeDOM();
  try {
    const { runtime, clock, context, present } = await mountBatchedRuntime({
      dom,
    });
    context.operations = [];
    present({ gen: 1, rows: [[[0, "A", 1, 0]], []] });
    expect(clock.scheduled).toBe(1);

    runtime.dispose();
    expect(clock.scheduled).toBe(0);
    expect(clock.cancels).toBe(1);
    present({ gen: 2, rows: [[[0, "B", 1, 0]], []] });
    clock.tick();
    expect(context.operations).toEqual([]);
    expect(runtime.paintStatistics.pending).toBe(false);
  } finally {
    dom.restore();
  }
});

test("a resize paints the pending frame synchronously and fully", async () => {
  const dom = installFakeDOM();
  try {
    const { runtime, clock, context, present } = await mountBatchedRuntime({
      dom,
    });
    present({ gen: 1, rows: [[[0, "A", 1, 0]], []] });
    clock.tick();
    context.operations = [];
    present({
      gen: 2,
      rows: [[[0, "B", 1, 0]], []],
      damage: {
        textRows: [[0, [[0, 1]]]],
        requiresFullTextRepaint: false,
        requiresFullGraphicsReplay: false,
      },
    });
    expect(clock.scheduled).toBe(1);

    dom.triggerResize();
    // The canvas was just cleared by its resize, so the paint could not wait.
    expect(clock.scheduled).toBe(0);
    expect(clock.cancels).toBe(1);
    expect(fillTextOperations(context, "B")).toHaveLength(1);
    expect(context.operations).toContainEqual({
      type: "clearRect",
      x: 0,
      y: 0,
      width: 100,
      height: 108,
    });
    expect(runtime.paintStatistics.pending).toBe(false);

    context.operations = [];
    clock.tick();
    expect(context.operations).toEqual([]);
  } finally {
    dom.restore();
  }
});

test("a document becoming visible paints frames that arrived while it was hidden", async () => {
  const dom = installFakeDOM();
  try {
    const { runtime, clock, context, present } = await mountBatchedRuntime({
      dom,
    });
    present({ gen: 1, rows: [[[0, "A", 1, 0]], []] });
    clock.tick();

    runtime.setDocumentVisible(false);
    context.operations = [];
    present({
      gen: 2,
      rows: [[[0, "B", 1, 0]], []],
      damage: {
        textRows: [[0, [[0, 1]]]],
        requiresFullTextRepaint: false,
        requiresFullGraphicsReplay: false,
      },
    });
    // A hidden document never ticks its animation frames.
    expect(context.operations).toEqual([]);

    runtime.setDocumentVisible(true);
    expect(clock.scheduled).toBe(0);
    expect(fillTextOperations(context, "B")).toHaveLength(1);
    expect(context.operations).toContainEqual({
      type: "clearRect",
      x: 0,
      y: 0,
      width: 100,
      height: 108,
    });

    // Becoming visible with nothing pending paints nothing.
    context.operations = [];
    runtime.setDocumentVisible(false);
    runtime.setDocumentVisible(true);
    expect(context.operations).toEqual([]);
  } finally {
    dom.restore();
  }
});

test('the default scheduler is the global animation frame; "synchronous" opts out', async () => {
  const dom = installFakeDOM();
  const previousRequest = globalThis.requestAnimationFrame;
  const previousCancel = globalThis.cancelAnimationFrame;
  const clock = new ManualAnimationFrameScheduler();
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) =>
    clock.requestAnimationFrame(callback)) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((handle: number) =>
    clock.cancelAnimationFrame(handle)) as typeof cancelAnimationFrame;
  try {
    const frame = {
      version: 2,
      width: 4,
      height: 2,
      styles: [null],
      rows: [[[0, "A", 1, 0]], []],
    };
    for (const scheduling of ["default", "synchronous"] as const) {
      const bridge = new BrowserWASIBridge({
        sceneId: "main",
        columns: 4,
        rows: 2,
      });
      const runtime = new WebHostSceneRuntime({
        mount: new FakeElement("div") as unknown as HTMLElement,
        descriptor: { id: "main", title: "Main", isDefault: true },
        style: { fontSize: 20 },
        bridge,
        onInput: () => {},
        ...(scheduling === "synchronous"
          ? { paintScheduling: "synchronous" as const }
          : {}),
      });
      await runtime.mount();
      const context = dom.canvases[dom.canvases.length - 1]!.context;
      context.operations = [];
      bridge.stdout.write(encoder.encode(surfaceRecord(frame)));
      if (scheduling === "default") {
        expect(fillTextOperations(context, "A")).toEqual([]);
        expect(clock.scheduled).toBe(1);
        clock.tick();
      } else {
        expect(clock.scheduled).toBe(0);
      }
      expect(fillTextOperations(context, "A")).toHaveLength(1);
      runtime.dispose();
    }
  } finally {
    globalThis.requestAnimationFrame = previousRequest;
    globalThis.cancelAnimationFrame = previousCancel;
    dom.restore();
  }
});

function pointerEvent(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    button: 0,
    buttons: 0,
    clientX: 0,
    clientY: 0,
    pointerId: 1,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    preventDefault() {},
    ...overrides,
  };
}

function fillTextOperations(
  context: RecordingCanvasContext,
  text: string,
): RecordingCanvasOperation[] {
  return context.operations.filter(
    (operation) => operation.type === "fillText" && operation.text === text,
  );
}

function fillRectOperations(
  context: RecordingCanvasContext,
  fillStyle: string,
): RecordingCanvasOperation[] {
  return context.operations.filter(
    (operation) =>
      operation.type === "fillRect" && operation.fillStyle === fillStyle,
  );
}

function drawImageOperations(
  context: RecordingCanvasContext,
): RecordingCanvasOperation[] {
  return context.operations.filter(
    (operation) => operation.type === "drawImage",
  );
}

function readCanvasTextLikePixels(canvas: FakeCanvasElement): string {
  const textSamples = new Map<string, { x: number; y: number; text: string }>();

  for (const operation of canvas.context.operations) {
    if (operation.type === "clearRect") {
      const rect = operationRect(operation);
      if (!rect) {
        continue;
      }
      for (const [key, sample] of textSamples) {
        if (textSampleInRect(sample, rect)) {
          textSamples.delete(key);
        }
      }
      continue;
    }

    if (operation.type !== "fillText" || typeof operation.text !== "string") {
      continue;
    }
    const x = Number(operation.x);
    const y = Number(operation.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      continue;
    }
    textSamples.set(`${x}:${y}`, { x, y, text: operation.text });
  }

  const rows = new Map<number, Array<{ x: number; text: string }>>();
  for (const sample of textSamples.values()) {
    const row = rows.get(sample.y) ?? [];
    row.push({ x: sample.x, text: sample.text });
    rows.set(sample.y, row);
  }

  return Array.from(rows.entries())
    .sort(([lhs], [rhs]) => lhs - rhs)
    .map(([, row]) =>
      row
        .sort((lhs, rhs) => lhs.x - rhs.x)
        .map((sample) => sample.text)
        .join(""),
    )
    .join("\n");
}

function operationRect(
  operation: RecordingCanvasOperation,
): { x: number; y: number; width: number; height: number } | undefined {
  const x = Number(operation.x);
  const y = Number(operation.y);
  const width = Number(operation.width);
  const height = Number(operation.height);
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height)
  ) {
    return undefined;
  }
  return { x, y, width, height };
}

function textSampleInRect(
  sample: { x: number; y: number },
  rect: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    sample.x >= rect.x &&
    sample.x < rect.x + rect.width &&
    sample.y >= rect.y &&
    sample.y < rect.y + rect.height
  );
}

function childWithClass(element: FakeElement, className: string): FakeElement {
  const child = element.children.find((child) => child.className === className);
  if (!child) {
    throw new Error(`missing child with class ${className}`);
  }
  return child;
}

function childWithData(
  element: FakeElement,
  key: string,
  value: string,
): FakeElement {
  const child = element.children.find((child) => child.dataset[key] === value);
  if (!child) {
    throw new Error(`missing child with data-${key} ${value}`);
  }
  return child;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/// Drains exactly `byteCount` bytes, letting the chunked writer resume between
/// reads. Bounded by turns rather than by a sleep.
async function drainExactly(
  reader: SharedInputQueueReader,
  byteCount: number,
): Promise<Uint8Array> {
  const received: number[] = [];
  for (let turn = 0; turn < 4_096 && received.length < byteCount; turn += 1) {
    const chunk = reader.readAvailable(byteCount - received.length);
    if (chunk) {
      received.push(...chunk);
    }
    // A macrotask turn: the writer resumes on the reader's `Atomics.notify`,
    // which lands in a task rather than a microtask.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  if (received.length !== byteCount) {
    throw new Error(
      `timed out draining shared input: got ${received.length} of ${byteCount} bytes`,
    );
  }
  return new Uint8Array(received);
}

async function waitForAvailableInput(
  reader: SharedInputQueueReader,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (reader.availableBytes() > 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1);
    });
  }
  throw new Error("timed out waiting for WASI input capacity retry");
}

// Drives a single wheel event over a 4x2 surface (cellWidth 10, cellHeight 27
// under the fake DOM) with the given wheel mode and published scroll regions,
// and reports whether the wheel was forwarded to the app and/or preventDefault'd.
// Assumes a fake DOM is already installed by the caller.
async function wheelScenario(options: {
  wheelMode?: WheelMode;
  captureWheelInput?: boolean;
  scrollRegions?: Array<Record<string, unknown>>;
  wheel: { clientX: number; clientY: number; deltaX?: number; deltaY?: number };
}): Promise<{
  captured: boolean;
  wheelPrevented: boolean;
  overscrollBehavior: string;
}> {
  const inputs: string[] = [];
  const bridge = new BrowserWASIBridge({
    sceneId: "main",
    columns: 4,
    rows: 2,
  });
  const mount = new FakeElement("div");
  const runtime = new WebHostSceneRuntime({
    mount: mount as unknown as HTMLElement,
    descriptor: { id: "main", title: "Main", isDefault: true },
    style: { fontSize: 20 },
    bridge,
    onInput: (chunk) => {
      inputs.push(decoder.decode(chunk));
    },
    synchronizeAccessibilityFocus: false,
    wheelMode: options.wheelMode,
    captureWheelInput: options.captureWheelInput,
  });

  await runtime.mount();
  const frame: Record<string, unknown> = {
    version: 2,
    width: 4,
    height: 2,
    styles: [null],
    rows: [[], []],
  };
  if (options.scrollRegions) {
    frame.scrollRegions = options.scrollRegions;
  }
  bridge.stdout.write(encoder.encode(surfaceRecord(frame)));

  let wheelPrevented = false;
  runtime.terminalMount.dispatch("wheel", {
    clientX: options.wheel.clientX,
    clientY: options.wheel.clientY,
    deltaX: options.wheel.deltaX ?? 0,
    deltaY: options.wheel.deltaY ?? 0,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    preventDefault() {
      wheelPrevented = true;
    },
  });

  return {
    captured: inputs.some((i) => i.includes("scrolled")),
    wheelPrevented,
    overscrollBehavior: String(runtime.terminalMount.style.overscrollBehavior),
  };
}

function surfaceRecord(frame: Record<string, unknown>): string {
  return `\u001Esurface:${JSON.stringify(frame)}\n`;
}

interface FakeDOMOptions {
  devicePixelRatio?: number;
  createImageBitmap?: (blob: Blob) => Promise<unknown>;
  /**
   * Installs a `matchMedia` whose `(pointer: coarse)` result starts at this
   * value. Omit it to leave `matchMedia` absent, which is what most tests
   * want: the runtime then reads "desktop" and declares nothing.
   */
  coarsePointer?: FakeMediaQueryList;
}

/**
 * The slice of `MediaQueryList` the runtime uses, plus a `setMatches` the test
 * calls to simulate the device changing paradigm mid-session.
 */
class FakeMediaQueryList {
  matches: boolean;
  private readonly listeners = new Set<(event: { matches: boolean }) => void>();

  constructor(matches: boolean) {
    this.matches = matches;
  }

  addEventListener(
    _type: "change",
    listener: (event: { matches: boolean }) => void,
  ): void {
    this.listeners.add(listener);
  }

  removeEventListener(
    _type: "change",
    listener: (event: { matches: boolean }) => void,
  ): void {
    this.listeners.delete(listener);
  }

  setMatches(matches: boolean): void {
    this.matches = matches;
    for (const listener of this.listeners) {
      listener({ matches });
    }
  }
}

function installFakeDOM(options: FakeDOMOptions = {}): {
  canvases: FakeCanvasElement[];
  triggerResize(): void;
  restore(): void;
} {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousResizeObserver = globalThis.ResizeObserver;
  const previousCreateImageBitmap = globalThis.createImageBitmap;
  const previousMatchMedia = globalThis.matchMedia;
  const canvases: FakeCanvasElement[] = [];
  const resizeObservers: FakeResizeObserver[] = [];

  globalThis.document = {
    createTextNode: (text: string) => {
      const node = new FakeElement("#text");
      node.textContent = text;
      return node;
    },
    createElement: (tagName: string) => {
      if (tagName === "canvas") {
        const canvas = new FakeCanvasElement();
        canvases.push(canvas);
        return canvas;
      }
      return new FakeElement(tagName);
    },
  } as unknown as Document;
  globalThis.window = {
    devicePixelRatio: options.devicePixelRatio ?? 1,
  } as unknown as Window & typeof globalThis;
  globalThis.ResizeObserver = class extends FakeResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      super(callback);
      resizeObservers.push(this);
    }
  } as unknown as typeof ResizeObserver;
  if (options.createImageBitmap) {
    globalThis.createImageBitmap =
      options.createImageBitmap as typeof createImageBitmap;
  }
  if (options.coarsePointer) {
    const coarsePointer = options.coarsePointer;
    globalThis.matchMedia = ((query: string) =>
      query === "(pointer: coarse)"
        ? coarsePointer
        : new FakeMediaQueryList(false)) as unknown as typeof matchMedia;
  }

  return {
    canvases,
    triggerResize: () => {
      for (const observer of resizeObservers) {
        observer.trigger();
      }
    },
    restore: () => {
      globalThis.document = previousDocument;
      globalThis.window = previousWindow;
      globalThis.ResizeObserver = previousResizeObserver;
      globalThis.createImageBitmap = previousCreateImageBitmap;
      globalThis.matchMedia = previousMatchMedia;
    },
  };
}

class FakeResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(): void {}
  disconnect(): void {}

  trigger(): void {
    this.callback([], this as unknown as ResizeObserver);
  }
}

class FakeStyle {
  [key: string]: unknown;

  private readonly values = new Map<string, string>();
  private readonly priorities = new Map<string, string>();

  setProperty(name: string, value: string, priority?: string): void {
    this.values.set(name, value);
    this.priorities.set(name, priority ?? "");
  }

  getPropertyValue(name: string): string {
    return this.values.get(name) ?? "";
  }

  getPropertyPriority(name: string): string {
    return this.priorities.get(name) ?? "";
  }
}

class FakeElement {
  readonly tagName: string;
  readonly style = new FakeStyle();
  readonly dataset: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  private readonly eventListeners = new Map<
    string,
    Set<(event: Record<string, unknown>) => void>
  >();
  private readonly attributes = new Map<string, string>();

  className = "";
  id = "";
  hidden = false;
  focused = false;
  lastFocusOptions: FocusOptions | undefined;
  tabIndex = 0;
  textContent = "";
  rect = {
    left: 0,
    top: 0,
    width: 100,
    height: 108,
    right: 100,
    bottom: 108,
  };

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  insertBefore(child: FakeElement, before: FakeElement | null): FakeElement {
    const old = this.children.indexOf(child);
    if (old >= 0) this.children.splice(old, 1);
    const index = before ? this.children.indexOf(before) : this.children.length;
    this.children.splice(index, 0, child);
    return child;
  }

  replaceChildren(...children: FakeElement[]): void {
    this.children.splice(0, this.children.length, ...children);
  }

  remove(): void {}
  focus(options?: FocusOptions): void {
    this.focused = true;
    this.lastFocusOptions = options;
  }
  setPointerCapture(): void {}
  releasePointerCapture(): void {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  getBoundingClientRect(): typeof this.rect {
    if (this.style.font === "inherit" && this.style.whiteSpace === "pre") {
      const width =
        this.textContent === "W".repeat(64)
          ? 640
          : ["漢", "🙂", "👩‍💻"].includes(this.textContent)
            ? 20
            : 10;
      return { ...this.rect, width, height: 27 };
    }
    if (this.style.lineHeight === "1.5") return { ...this.rect, height: 27 };
    if (
      this.style.visibility === "hidden" &&
      this.textContent === "W".repeat(64)
    ) {
      return { ...this.rect, width: 640, height: 27 };
    }
    return this.rect;
  }

  addEventListener(
    type: string,
    listener: (event: Record<string, unknown>) => void,
  ): void {
    let listeners = this.eventListeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.eventListeners.set(type, listeners);
    }
    listeners.add(listener);
  }

  removeEventListener(
    type: string,
    listener: (event: Record<string, unknown>) => void,
  ): void {
    this.eventListeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: Record<string, unknown>): void {
    for (const listener of this.eventListeners.get(type) ?? []) {
      listener(event);
    }
  }
}

class FakeCanvasElement extends FakeElement {
  readonly context = new RecordingCanvasContext();
  width = 0;
  height = 0;

  constructor() {
    super("canvas");
    this.rect = {
      left: 0,
      top: 0,
      width: 100,
      height: 108,
      right: 100,
      bottom: 108,
    };
  }

  getContext(contextId: string): RecordingCanvasContext | undefined {
    return contextId === "2d" ? this.context : undefined;
  }
}

type RecordingCanvasOperation = Record<string, unknown>;

class RecordingCanvasContext {
  operations: RecordingCanvasOperation[] = [];
  fillStyle = "";
  strokeStyle = "";
  font = "";
  textBaseline = "";
  globalAlpha = 1;
  lineWidth = 1;
  lineCap = "butt";

  private lineDash: number[] = [];
  private path: Array<[string, ...number[]]> = [];

  measureText(text: string): { width: number } {
    return { width: Math.max(1, Array.from(text).length) * 10 };
  }

  setTransform(
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
  ): void {
    this.operations.push({ type: "setTransform", a, b, c, d, e, f });
  }

  clearRect(x: number, y: number, width: number, height: number): void {
    this.operations.push({ type: "clearRect", x, y, width, height });
  }

  fillRect(x: number, y: number, width: number, height: number): void {
    this.operations.push({
      type: "fillRect",
      x,
      y,
      width,
      height,
      fillStyle: this.fillStyle,
      globalAlpha: this.globalAlpha,
    });
  }

  fillText(text: string, x: number, y: number): void {
    this.operations.push({
      type: "fillText",
      text,
      x,
      y,
      fillStyle: this.fillStyle,
      font: this.font,
      globalAlpha: this.globalAlpha,
    });
  }

  beginPath(): void {
    this.path = [];
  }

  save(): void {
    this.operations.push({ type: "save" });
  }

  restore(): void {
    this.operations.push({ type: "restore" });
  }

  rect(x: number, y: number, width: number, height: number): void {
    this.path.push(["rect", x, y, width, height]);
    this.operations.push({ type: "rect", x, y, width, height });
  }

  clip(): void {
    this.operations.push({
      type: "clip",
      path: [...this.path],
    });
  }

  drawImage(
    image: unknown,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    this.operations.push({
      type: "drawImage",
      imageId:
        image && typeof image === "object" && "imageId" in image
          ? (image as { imageId: unknown }).imageId
          : undefined,
      x,
      y,
      width,
      height,
    });
  }

  moveTo(x: number, y: number): void {
    this.path.push(["moveTo", x, y]);
  }

  lineTo(x: number, y: number): void {
    this.path.push(["lineTo", x, y]);
  }

  bezierCurveTo(
    control1X: number,
    control1Y: number,
    control2X: number,
    control2Y: number,
    x: number,
    y: number,
  ): void {
    this.path.push([
      "bezierCurveTo",
      control1X,
      control1Y,
      control2X,
      control2Y,
      x,
      y,
    ]);
  }

  stroke(): void {
    this.operations.push({
      type: "stroke",
      strokeStyle: this.strokeStyle,
      lineWidth: this.lineWidth,
      lineDash: [...this.lineDash],
      path: [...this.path],
    });
  }

  setLineDash(lineDash: number[]): void {
    this.lineDash = [...lineDash];
  }
}

test("scene and document visibility drive the runtime suspension hook", () => {
  const dom = installFakeDOM();
  try {
    const events: boolean[] = [];
    class SuspensionProbeRuntime extends WebHostSceneRuntime {
      protected override onRuntimeSuspensionChange(suspended: boolean): void {
        events.push(suspended);
      }
    }

    const mount = new FakeElement("div");
    const runtime = new SuspensionProbeRuntime({
      mount: mount as unknown as HTMLElement,
      descriptor: { id: "life", title: "Life", isDefault: true },
      style: {},
      onInput: () => {},
    });

    runtime.setVisible(true);
    expect(events).toEqual([]);

    runtime.setVisible(false);
    expect(events).toEqual([true]);

    runtime.setVisible(true);
    expect(events).toEqual([true, false]);

    runtime.setDocumentVisible(false);
    expect(events).toEqual([true, false, true]);

    // Scene switches while the document stays hidden must not resume.
    runtime.setVisible(false);
    runtime.setVisible(true);
    expect(events).toEqual([true, false, true]);

    runtime.setDocumentVisible(true);
    expect(events).toEqual([true, false, true, false]);
  } finally {
    dom.restore();
  }
});

test("suspendWhenHidden: false keeps hidden scenes running", () => {
  const dom = installFakeDOM();
  try {
    const events: boolean[] = [];
    class SuspensionProbeRuntime extends WebHostSceneRuntime {
      protected override onRuntimeSuspensionChange(suspended: boolean): void {
        events.push(suspended);
      }
    }

    const mount = new FakeElement("div");
    const runtime = new SuspensionProbeRuntime({
      mount: mount as unknown as HTMLElement,
      descriptor: { id: "life", title: "Life", isDefault: true },
      style: {},
      onInput: () => {},
      suspendWhenHidden: false,
    });

    runtime.setVisible(true);
    runtime.setVisible(false);
    runtime.setDocumentVisible(false);
    expect(events).toEqual([]);
  } finally {
    dom.restore();
  }
});

test("dom renderer mounts a DOM surface and renders decoded frames as text elements", async () => {
  const dom = installFakeDOM();
  try {
    const bridge = new BrowserWASIBridge({
      sceneId: "main",
      columns: 4,
      rows: 2,
    });
    const mount = new FakeElement("div");
    const runtime = new WebHostSceneRuntime({
      mount: mount as unknown as HTMLElement,
      descriptor: { id: "main", title: "Main", isDefault: true },
      style: {
        fontSize: 20,
        fontFamily: "Test Mono",
        theme: {
          foreground: "#eeeeee",
          background: "#101820",
        },
      },
      bridge,
      onInput: () => {},
      renderer: "dom",
    });

    await runtime.mount();
    await runtime.fontReady;

    const terminalMount = runtime.terminalMount as unknown as FakeElement;
    const surface = terminalMount.children[0]!;
    expect(surface.tagName).toBe("DIV");
    expect(surface.className).toBe(
      "webhost-scene__surface webhost-scene__surface--dom",
    );
    expect(surface.getAttribute("aria-hidden")).toBe("true");

    bridge.stdout.write(encoder.encode(transportFixture("web-surface-styled")));

    // Frame is 4x2 at cellWidth 10 and cellHeight 27 from the CSS-probe fake.
    expect(surface.style.width).toBe("40px");
    expect(surface.style.height).toBe("54px");
    expect(surface.style.lineHeight).toBe("27px");

    const rowsLayer = surface.children[0]!;
    expect(rowsLayer.className).toBe("webhost-scene__surface-rows");
    expect(rowsLayer.children).toHaveLength(2);
    expect(rowsLayer.children[1]!.style.top).toBe("27px");

    // Cell [0,"A",1,1]: em 19 = bold + italic + reverse video, dashed
    // underline + dotted strikethrough, opacity 0.75.
    const styled = rowsLayer.children[0]!.children[0]!;
    expect(styled.textContent).toBe("A");
    expect(styled.style.color).toBe("#000000FF");
    expect(styled.style.backgroundColor).toBe("#E05757FF");
    expect(styled.style.fontWeight).toBe("700");
    expect(styled.style.fontStyle).toBe("italic");
    expect(styled.style.textDecorationLine).toBe("none");
    expect(decodeURIComponent(styled.style.backgroundImage ?? "")).toContain(
      "#EBB33CFF",
    );
    expect(decodeURIComponent(styled.style.backgroundImage ?? "")).toContain(
      "#E05757FF",
    );
    expect(styled.style.opacity).toBe("0.75");

    // Cell [1,"界",2,2]: double-width run occupies two cells.
    const wide = rowsLayer.children[0]!.children[1]!;
    expect(wide.textContent).toBe("界");
    expect(wide.style.left).toBe("10px");
    expect(wide.style.width).toBe("20px");

    // Cell [2,"B",1,0]: null style falls back to the theme foreground; the
    // trailing blank cell [3," ",1,0] remains selectable.
    const row1 = rowsLayer.children[1]!;
    const plain = row1.children.find((child) => child.textContent === "B")!;
    expect(plain.textContent).toBe("B");
    expect(plain.style.color).toBe("#eeeeee");
    expect(row1.children.map((child) => child.textContent)).toContain(" ");
  } finally {
    dom.restore();
  }
});

test("runtime forwards observable DOM image misses through the optional bridge seam", async () => {
  const dom = installFakeDOM();
  try {
    const misses: string[][] = [];
    let sink: WebHostOutputSink | undefined;
    const bridge = {
      bindOutput: (next: WebHostOutputSink) => {
        sink = next;
      },
      resize: () => {},
      updateRenderStyle: () => {},
      sendInput: () => {},
      requestImagePayloads: (ids: readonly string[]) => {
        misses.push([...ids]);
      },
      dispose: () => {},
    };
    const runtime = new WebHostSceneRuntime({
      mount: new FakeElement("div") as unknown as HTMLElement,
      descriptor: { id: "main", title: "Main", isDefault: true },
      style: {},
      bridge,
      onInput: () => {},
      renderer: "dom",
    });
    await runtime.mount();
    await runtime.fontReady;

    sink?.presentSurface({
      version: 2,
      epoch: 90,
      gen: 1,
      width: 2,
      height: 1,
      styles: [null],
      rows: [[]],
      images: [
        {
          id: "png:missing",
          format: "png",
          bounds: [0, 0, 1, 1],
          visibleBounds: [0, 0, 1, 1],
          scalingMode: "stretch",
        },
      ],
    });

    expect(misses).toEqual([["png:missing"]]);
  } finally {
    dom.restore();
  }
});

test("dom renderer leaves Alt-drag pointer input to native text selection", async () => {
  const dom = installFakeDOM();
  try {
    const inputs: Uint8Array[] = [];
    const mount = new FakeElement("div");
    const bridge = new BrowserWASIBridge({ sceneId: "main" });
    const runtime = new WebHostSceneRuntime({
      mount: mount as unknown as HTMLElement,
      descriptor: { id: "main", title: "Main", isDefault: true },
      style: {},
      onInput: (chunk) => inputs.push(chunk),
      renderer: "dom",
      bridge,
    });
    await runtime.mount();
    await runtime.fontReady;
    bridge.stdout.write(
      encoder.encode(
        surfaceRecord({
          version: 2,
          width: 4,
          height: 2,
          styles: [null],
          rows: [[], []],
        }),
      ),
    );

    let prevented = 0;
    runtime.terminalMount.dispatch(
      "pointerdown",
      pointerEvent({
        button: 0,
        buttons: 1,
        clientX: 25,
        clientY: 10,
        altKey: true,
        preventDefault: () => {
          prevented += 1;
        },
      }),
    );
    runtime.terminalMount.dispatch(
      "pointermove",
      pointerEvent({
        buttons: 1,
        clientX: 40,
        clientY: 10,
        altKey: true,
      }),
    );
    runtime.terminalMount.dispatch(
      "pointerup",
      pointerEvent({
        button: 0,
        clientX: 40,
        clientY: 10,
        altKey: true,
      }),
    );
    expect(inputs).toHaveLength(0);
    expect(prevented).toBe(0);

    // Without Alt, pointer input is forwarded to the app as usual.
    runtime.terminalMount.dispatch(
      "pointerdown",
      pointerEvent({
        button: 0,
        buttons: 1,
        clientX: 25,
        clientY: 10,
      }),
    );
    expect(inputs.length).toBeGreaterThan(0);

    // The canvas renderer has no text nodes to select — Alt-drag still
    // belongs to the app there.
    const canvasInputs: Uint8Array[] = [];
    const canvasMount = new FakeElement("div");
    const canvasRuntime = new WebHostSceneRuntime({
      mount: canvasMount as unknown as HTMLElement,
      descriptor: { id: "main", title: "Main", isDefault: true },
      style: {},
      onInput: (chunk) => canvasInputs.push(chunk),
    });
    await canvasRuntime.mount();
    canvasRuntime.terminalMount.dispatch(
      "pointerdown",
      pointerEvent({
        button: 0,
        buttons: 1,
        clientX: 25,
        clientY: 10,
        altKey: true,
      }),
    );
    expect(canvasInputs.length).toBeGreaterThan(0);
  } finally {
    dom.restore();
  }
});
