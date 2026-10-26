// Campaign-two W2 adversarial browser journeys (STUI-1157).
//
// Drives the real `WebHostSceneRuntime` and its real Canvas/DOM painters in a
// real Chromium through a synthetic transport peer (a `BrowserWASIBridge` whose
// stdout we write and whose stdin we read), exactly as the shipped
// preview-readiness and paint-batching fixtures do. No compiled WASM, no
// sibling checkout: every byte on the wire is produced by this fixture or by
// the production runtime under test. A second sub-API drives the production
// `WebSocketSceneBridge` against a controllable fake socket for the
// reconnect/backlog journeys.

import {
  BrowserWASIBridge,
  type WebHostAccessibilityNode,
  type WebHostOutputRecord,
  type WebHostOutputSink,
  WebHostSceneRuntime,
  type WebHostSurfaceCell,
  type WebHostSurfaceFrame,
  type WebHostSurfaceImage,
  type WebHostSurfaceLinkRow,
  WebSocketSceneBridge,
  type WebSocketSceneSocket,
  type WheelMode,
} from "../dist/index.js";

const recordPrefix = "\u001e";
const textDecoder = new TextDecoder();

interface SceneOptions {
  renderer?: "canvas" | "dom";
  columns?: number;
  rows?: number;
  wheelMode?: WheelMode;
  suspendWhenHidden?: boolean;
  mountWidth?: number;
  mountHeight?: number;
  /** Runtime focus synchronization; off unless a journey asks for it. */
  synchronizeAccessibilityFocus?: boolean;
}

interface Scene {
  runtime: WebHostSceneRuntime;
  bridge: BrowserWASIBridge;
  mount: HTMLElement;
  inputs: string[];
  resizes: {
    columns: number;
    rows: number;
    cellWidth?: number;
    cellHeight?: number;
  }[];
  errors: string[];
}

const scenes: Scene[] = [];

function requireScene(id: number): Scene {
  const scene = scenes[id];
  if (!scene) throw new Error(`No W2 scene ${id}`);
  return scene;
}

function row(text: string, styleIndex = 0): WebHostSurfaceCell[] {
  return [[0, text, Array.from(text).length, styleIndex]];
}

function fullRows(
  width: number,
  height: number,
  glyph = ".",
): WebHostSurfaceCell[][] {
  return Array.from({ length: height }, () =>
    Array.from(
      { length: width },
      (_, x): WebHostSurfaceCell => [x, glyph, 1, 0],
    ),
  );
}

const scene = {
  async create(options: SceneOptions = {}): Promise<number> {
    const mount = document.createElement("div");
    mount.style.width = `${options.mountWidth ?? 640}px`;
    mount.style.height = `${options.mountHeight ?? 360}px`;
    document.body.append(mount);
    const columns = options.columns ?? 40;
    const rows = options.rows ?? 12;
    const bridge = new BrowserWASIBridge({
      sceneId: `w2-${scenes.length}`,
      columns,
      rows,
    });
    const inputs: string[] = [];
    const resizes: Scene["resizes"] = [];
    bridge.subscribeResize((c, r, cellWidth, cellHeight) => {
      resizes.push({ columns: c, rows: r, cellWidth, cellHeight });
    });
    bridge.stdin.subscribe((chunk) => {
      for (const record of textDecoder.decode(chunk).split("\n"))
        if (record) inputs.push(record);
    });
    const errors: string[] = [];
    const runtime = new WebHostSceneRuntime({
      mount,
      descriptor: { id: `w2-${scenes.length}`, title: "W2", isDefault: true },
      style: { fontFamily: "monospace", fontSize: 16 },
      renderer: options.renderer ?? "canvas",
      domFont: { assetBase: "/fonts/" },
      bridge,
      wheelMode: options.wheelMode,
      suspendWhenHidden: options.suspendWhenHidden,
      synchronizeAccessibilityFocus:
        options.synchronizeAccessibilityFocus ?? false,
      onInput: (chunk) => bridge.sendInput(chunk),
      onFrameDiagnostic: () => {},
    });
    const id = scenes.length;
    scenes.push({ runtime, bridge, mount, inputs, resizes, errors });
    await runtime.mount();
    runtime.setVisible(true);
    await runtime.fontReady;
    return id;
  },

  present(
    id: number,
    frame: Partial<WebHostSurfaceFrame> & { width: number; height: number },
  ): void {
    const scene = requireScene(id);
    const complete: WebHostSurfaceFrame = {
      version: 2,
      styles: [null],
      rows: [],
      ...frame,
    };
    scene.bridge.stdout.write(
      `${recordPrefix}surface:${JSON.stringify(complete)}\n`,
    );
  },

  presentText(id: number, lines: string[], width?: number): void {
    const w =
      width ?? Math.max(1, ...lines.map((line) => Array.from(line).length));
    this.present(id, {
      width: w,
      height: lines.length,
      styles: [null],
      rows: lines.map((line) => row(line)),
    });
  },

  presentRaw(id: number, text: string): void {
    requireScene(id).bridge.stdout.write(text);
  },

  presentAccessibility(
    id: number,
    nodes: WebHostAccessibilityNode[],
    width = 40,
    height = 12,
  ): void {
    this.present(id, {
      width,
      height,
      styles: [null],
      rows: Array.from({ length: height }, () => [] as WebHostSurfaceCell[]),
      accessibilityTree: nodes,
    });
  },

  async resizeMount(id: number, width: number, height: number): Promise<void> {
    const scene = requireScene(id);
    scene.mount.style.width = `${width}px`;
    scene.mount.style.height = `${height}px`;
    scene.runtime.refreshGeometry();
    await new Promise(requestAnimationFrame);
  },

  resizeMountSync(id: number, width: number, height: number): void {
    const scene = requireScene(id);
    scene.mount.style.width = `${width}px`;
    scene.mount.style.height = `${height}px`;
    scene.runtime.refreshGeometry();
  },

  setDocumentVisible(id: number, visible: boolean): void {
    requireScene(id).runtime.setDocumentVisible(visible);
  },

  setVisible(id: number, visible: boolean): void {
    requireScene(id).runtime.setVisible(visible);
  },

  async settle(): Promise<void> {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  },

  dispatchKey(id: number, init: KeyboardEventInit): void {
    const terminal = requireScene(id).runtime.terminalMount;
    terminal.focus();
    terminal.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    );
  },

  inputs(id: number): string[] {
    return [...requireScene(id).inputs];
  },

  mouseInputs(id: number): string[] {
    return requireScene(id).inputs.filter((record) =>
      record.startsWith(`${recordPrefix}mouse`),
    );
  },

  resizes(id: number): Scene["resizes"] {
    return requireScene(id).resizes.map((entry) => ({ ...entry }));
  },

  geometry(id: number): WebHostSceneRuntime["geometrySnapshot"] {
    return requireScene(id).runtime.geometrySnapshot;
  },

  paintStatistics(id: number): WebHostSceneRuntime["paintStatistics"] {
    return requireScene(id).runtime.paintStatistics;
  },

  cellMetrics(
    id: number,
  ):
    | { cellWidth: number; cellHeight: number; columns: number; rows: number }
    | undefined {
    const snapshot = requireScene(id).runtime.geometrySnapshot;
    if (!snapshot) return undefined;
    return {
      cellWidth: snapshot.cellWidth,
      cellHeight: snapshot.cellHeight,
      columns: snapshot.columns,
      rows: snapshot.rows,
    };
  },

  canvasPixel(
    id: number,
    cellX: number,
    cellY: number,
  ): [number, number, number, number] {
    const scene = requireScene(id);
    const canvas = scene.runtime.terminalMount.querySelector("canvas");
    const context = canvas?.getContext("2d", { willReadFrequently: true });
    const metrics = this.cellMetrics(id);
    if (!canvas || !context || !metrics) return [0, 0, 0, 0];
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = Math.max(
      0,
      Math.floor((cellX + 0.5) * metrics.cellWidth * scaleX),
    );
    const y = Math.max(
      0,
      Math.floor((cellY + 0.5) * metrics.cellHeight * scaleY),
    );
    const pixel = context.getImageData(x, y, 1, 1).data;
    return [pixel[0] ?? 0, pixel[1] ?? 0, pixel[2] ?? 0, pixel[3] ?? 0];
  },

  canvasChecksum(id: number): number {
    const scene = requireScene(id);
    const canvas = scene.runtime.terminalMount.querySelector("canvas");
    const context = canvas?.getContext("2d", { willReadFrequently: true });
    if (!canvas || !context) return 0;
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4)
      sum = (sum + data[i]! + data[i + 3]!) % 2147483647;
    return sum;
  },

  domText(id: number): string {
    const root = requireScene(id).runtime.terminalMount.querySelector(
      ".webhost-scene__surface--dom",
    );
    return root?.textContent ?? "";
  },

  accessibility(id: number): {
    order: string[];
    roles: Record<string, string | null>;
    labels: Record<string, string | null>;
  } {
    const terminal = requireScene(id).runtime.terminalMount;
    const nodes = Array.from(
      terminal.querySelectorAll<HTMLElement>(
        ".webhost-scene__accessibility-tree [data-accessibility-id]",
      ),
    );
    const order = nodes.map((node) => node.dataset.accessibilityId ?? "");
    const roles: Record<string, string | null> = {};
    const labels: Record<string, string | null> = {};
    for (const node of nodes) {
      const key = node.dataset.accessibilityId ?? "";
      roles[key] = node.getAttribute("role");
      labels[key] = node.getAttribute("aria-label");
    }
    return { order, roles, labels };
  },

  focusRingCells(id: number): [number, number, number, number] | undefined {
    const scene = requireScene(id);
    const ring = scene.runtime.terminalMount.querySelector<HTMLElement>(
      ".webhost-scene__focus-ring",
    );
    const metrics = this.cellMetrics(id);
    if (
      !ring ||
      !metrics ||
      scene.runtime.terminalMount.querySelector<HTMLElement>(
        ".webhost-scene__focus-layer",
      )?.hidden
    )
      return undefined;
    const round = (value: number, unit: number) => Math.round(value / unit);
    return [
      round(Number.parseFloat(ring.style.left) || 0, metrics.cellWidth),
      round(Number.parseFloat(ring.style.top) || 0, metrics.cellHeight),
      round(Number.parseFloat(ring.style.width) || 0, metrics.cellWidth),
      round(Number.parseFloat(ring.style.height) || 0, metrics.cellHeight),
    ];
  },

  caretVisible(id: number): boolean {
    const caret = requireScene(
      id,
    ).runtime.terminalMount.querySelector<HTMLElement>(".webhost-scene__caret");
    return !!caret && !caret.hidden && caret.style.display !== "none";
  },

  surfaceLinkCount(id: number): number {
    return requireScene(id).runtime.terminalMount.querySelectorAll(
      "a[data-surface-link]",
    ).length;
  },

  dispose(id: number): void {
    const scene = scenes[id];
    if (!scene) return;
    scene.runtime.dispose();
    scene.mount.remove();
  },

  disposeAll(): void {
    for (let id = 0; id < scenes.length; id += 1) this.dispose(id);
    scenes.length = 0;
  },

  helpers: { row, fullRows },
};

// ---- WebSocket reconnect/backlog sub-API -----------------------------------

class FakeSocket implements WebSocketSceneSocket {
  binaryType: BinaryType = "blob";
  readyState = 0;
  readonly sent: string[] = [];
  closedWith?: { code?: number; reason?: string };
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (typeof data === "string") this.sent.push(data);
    else if (data instanceof Uint8Array)
      this.sent.push(textDecoder.decode(data));
    else if (data instanceof ArrayBuffer)
      this.sent.push(textDecoder.decode(new Uint8Array(data)));
    else if (ArrayBuffer.isView(data))
      this.sent.push(
        textDecoder.decode(
          new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        ),
      );
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closedWith = { code, reason };
    this.emit("close", { code: code ?? 1000, reason: reason ?? "" });
  }

  addEventListener(type: string, listener: (event: never) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener as (event: unknown) => void);
  }

  removeEventListener(type: string, listener: (event: never) => void): void {
    this.listeners.get(type)?.delete(listener as (event: unknown) => void);
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  message(data: unknown): void {
    this.emit("message", { data });
  }

  serverClose(code: number, reason = ""): void {
    this.readyState = 3;
    this.closedWith = { code, reason };
    this.emit("close", { code, reason });
  }
}

interface SocketScene {
  bridge: WebSocketSceneBridge;
  sockets: FakeSocket[];
  records: WebHostOutputRecord[];
  errors: string[];
}

const socketScenes: SocketScene[] = [];

function requireSocketScene(id: number): SocketScene {
  const scene = socketScenes[id];
  if (!scene) throw new Error(`No W2 socket scene ${id}`);
  return scene;
}

const socket = {
  create(
    options: { instantReconnect?: boolean; bindOutput?: boolean } = {},
  ): number {
    const sockets: FakeSocket[] = [];
    const records: WebHostOutputRecord[] = [];
    const errors: string[] = [];
    const bridge = new WebSocketSceneBridge({
      sceneId: "ws",
      token: "test-token",
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      reconnectDelayMilliseconds: options.instantReconnect
        ? () => 0
        : undefined,
    });
    const sink: WebHostOutputSink = {
      presentSurface: (frame) => {
        records.push({ type: "surface", frame });
      },
      writeClipboard: (text) => {
        records.push({ type: "clipboard", text });
      },
      notifyRuntimeIssue: (issue) => {
        records.push({ type: "runtimeIssue", issue });
      },
      writeOutput: (text) => {
        records.push({ type: "text", text });
      },
      writeError: (text) => errors.push(text),
      resetSurfaceSession: () => {},
    };
    if (options.bindOutput !== false) bridge.bindOutput(sink);
    const id = socketScenes.length;
    socketScenes.push({ bridge, sockets, records, errors });
    return id;
  },

  openLatest(id: number): void {
    const scene = requireSocketScene(id);
    scene.sockets.at(-1)?.open();
  },

  sentByLatest(id: number): string[] {
    return [...(requireSocketScene(id).sockets.at(-1)?.sent ?? [])];
  },

  sentBy(id: number, index: number): string[] {
    return [...(requireSocketScene(id).sockets[index]?.sent ?? [])];
  },

  socketCount(id: number): number {
    return requireSocketScene(id).sockets.length;
  },

  closedWith(
    id: number,
    index: number,
  ): { code?: number; reason?: string } | undefined {
    return requireSocketScene(id).sockets[index]?.closedWith;
  },

  message(id: number, data: unknown): void {
    requireSocketScene(id).sockets.at(-1)?.message(data);
  },

  serverClose(id: number, code: number): void {
    requireSocketScene(id).sockets.at(-1)?.serverClose(code);
  },

  sendInput(id: number, text: string): void {
    requireSocketScene(id).bridge.sendInput(new TextEncoder().encode(text));
  },

  resize(id: number, columns: number, rows: number): void {
    requireSocketScene(id).bridge.resize(columns, rows);
  },

  async drainMicrotasks(): Promise<void> {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  },

  records(id: number): WebHostOutputRecord[] {
    return [...requireSocketScene(id).records];
  },

  errors(id: number): string[] {
    return [...requireSocketScene(id).errors];
  },

  surfaceFrame(epoch: number, gen: number, text: string): string {
    const frame: WebHostSurfaceFrame = {
      version: 2,
      epoch,
      gen,
      width: Array.from(text).length,
      height: 1,
      styles: [null],
      rows: [row(text)],
    };
    return `${recordPrefix}surface:${JSON.stringify(frame)}\n`;
  },

  deltaFrame(
    epoch: number,
    gen: number,
    baselineGen: number,
    text: string,
  ): string {
    const frame = {
      version: 3,
      encoding: "delta",
      epoch,
      gen,
      baselineGen,
      width: Array.from(text).length,
      height: 1,
      styles: [null],
      deltaRows: [[0, row(text)]],
    };
    return `${recordPrefix}surface:${JSON.stringify(frame)}\n`;
  },

  dispose(id: number): void {
    socketScenes[id]?.bridge.dispose();
  },

  disposeAll(): void {
    for (const scene of socketScenes) scene.bridge.dispose();
    socketScenes.length = 0;
  },
};

declare global {
  interface Window {
    __w2: typeof scene;
    __w2socket: typeof socket;
  }
}

window.__w2 = scene;
window.__w2socket = socket;

export type {
  WebHostAccessibilityNode,
  WebHostSurfaceFrame,
  WebHostSurfaceImage,
  WebHostSurfaceLinkRow,
};
