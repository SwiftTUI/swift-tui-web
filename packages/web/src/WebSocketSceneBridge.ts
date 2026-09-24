import { fitsUTF8, HOST_WIRE_MAX_RECORD_BYTES } from "./HostWireBudget.ts";
import type { WebHostSceneBridge } from "./WebHostSceneRuntime.ts";
import {
  encodeCapabilitiesControlMessage,
  encodePointerCapabilitiesControlMessage,
  encodeRenderStyleControlMessage,
  encodeResizeControlMessage,
  encodeResyncControlMessage,
  WebHostOutputDecoder,
  type WebHostOutputRecord,
  type WebHostOutputSink,
} from "./WebHostSurfaceTransport.ts";
import type { WebHostTerminalStyle } from "./WebHostTerminalStyle.ts";

export interface WebSocketSceneBridgeOptions {
  sceneId: string;
  token: string;
  baseURL?: string | URL;
  webSocketURL?: string | URL;
  webSocketFactory?: WebSocketSceneBridgeFactory;
  /**
   * Delay in milliseconds before reconnect attempt `attempt` (1-based) after
   * an abnormal socket close. Defaults to capped exponential backoff
   * (250 ms doubling to an 8 s ceiling). The counter resets when a
   * connection opens.
   */
  reconnectDelayMilliseconds?: (attempt: number) => number;
}

export type WebSocketSceneBridgeFactory = (
  url: string | URL,
) => WebSocketSceneSocket;

export interface WebSocketSceneSocket {
  binaryType: BinaryType;
  readonly readyState: number;
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: (event: Event) => void): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void;
  addEventListener(type: "close", listener: (event: CloseEvent) => void): void;
  addEventListener(type: "error", listener: (event: Event) => void): void;
  removeEventListener(type: "open", listener: (event: Event) => void): void;
  removeEventListener(
    type: "message",
    listener: (event: MessageEvent) => void,
  ): void;
  removeEventListener(
    type: "close",
    listener: (event: CloseEvent) => void,
  ): void;
  removeEventListener(type: "error", listener: (event: Event) => void): void;
}

const socketOpenState = 1;
const normalClosureCode = 1000;
const textEncoder = new TextEncoder();

function defaultReconnectDelayMilliseconds(attempt: number): number {
  return Math.min(250 * 2 ** (attempt - 1), 8_000);
}

export class WebSocketSceneBridge implements WebHostSceneBridge {
  readonly url: URL;

  private socket: WebSocketSceneSocket;
  private readonly createSocket: WebSocketSceneBridgeFactory;
  private readonly reconnectDelayMilliseconds: (attempt: number) => number;
  private decoder = new WebHostOutputDecoder();
  private receiveGeneration = 0;
  private receiveTail: Promise<void> = Promise.resolve();
  private pendingReceives = 0;
  private pendingReceiveBytes = 0;
  private readonly queuedInput: Uint8Array[] = [];
  private readonly queuedOutput: WebHostOutputRecord[] = [];
  private sink?: WebHostOutputSink;
  private disposed = false;
  private resourceFailure?: string;
  private queuedOutputBytes = 0;
  private reconnectAttempts = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  // The host state the runtime last declared, replayed after a reconnect.
  // The runtime dedupes its own declarations (`lastSentResize` and friends),
  // so without the replay a size or style that changed while disconnected —
  // or a server that restarted and lost its transport state — would never
  // be re-announced.
  private lastRenderStyleMessage?: Uint8Array;
  private lastResizeMessage?: Uint8Array;
  private lastPointerCapabilitiesMessage?: Uint8Array;

  private readonly handleOpen = () => {
    this.reconnectAttempts = 0;
    this.flushQueuedInput();
  };

  private readonly handleMessage = (event: MessageEvent) => {
    const generation = this.receiveGeneration;
    const message = event.data;
    const bytes =
      typeof message === "string"
        ? message.length * 3
        : message instanceof Blob
          ? message.size
          : message instanceof ArrayBuffer || ArrayBuffer.isView(message)
            ? message.byteLength
            : 0;
    const retainedBytes = Math.min(bytes, HOST_WIRE_MAX_RECORD_BYTES * 2);
    if (
      this.pendingReceives >= 32 ||
      this.pendingReceiveBytes + retainedBytes > HOST_WIRE_MAX_RECORD_BYTES * 4
    ) {
      this.socket.close(1009, "WebHost receive backlog exceeded");
      this.resetReceiveSession();
      return;
    }
    this.pendingReceives++;
    this.pendingReceiveBytes += retainedBytes;
    this.receiveTail = this.receiveTail
      .then(() => this.receive(message, generation))
      .catch(() => {
        if (!this.disposed && generation === this.receiveGeneration) {
          this.deliver(this.decoder.rejectOversizedMessage());
          this.sendPendingResyncRequests();
        }
      })
      .finally(() => {
        if (generation === this.receiveGeneration) {
          this.pendingReceives--;
          this.pendingReceiveBytes -= retainedBytes;
        }
      });
  };

  private readonly handleClose = (event: CloseEvent) => {
    this.resetReceiveSession();
    // A normal closure (1000) is deliberate: the server shut down, or a new
    // client attached and the channel closed this one as superseded.
    // Auto-reconnecting after a supersession would steal the session back
    // and ping-pong it between clients, so only abnormal closes (network
    // loss, protocol failure) are repaired.
    if (this.disposed || event.code === normalClosureCode) {
      return;
    }
    // Input queued for the dead connection belongs to its epoch; the server
    // refuses stale-token bytes for the same reason (blank beats stale).
    this.queuedInput.length = 0;
    this.scheduleReconnect();
  };

  private readonly handleError = () => {};

  constructor(options: WebSocketSceneBridgeOptions) {
    this.url = webSocketSceneURL(options);
    this.createSocket = options.webSocketFactory ?? defaultWebSocketFactory;
    this.reconnectDelayMilliseconds =
      options.reconnectDelayMilliseconds ?? defaultReconnectDelayMilliseconds;
    this.socket = this.createSocket(this.url);
    this.attachSocket(this.socket);
    // Declare wire capabilities first: queued input flushes in order on
    // open, so the declaration reaches the server ahead of any
    // resize/style/input record.
    this.sendInput(encodeCapabilitiesControlMessage());
  }

  bindOutput(sink: WebHostOutputSink): void {
    this.sink = sink;
    if (this.resourceFailure) sink.writeError?.(this.resourceFailure);
    this.queuedOutputBytes = 0;
    while (this.queuedOutput.length > 0) {
      this.deliver(this.queuedOutput.shift()!);
    }
  }

  resize(
    columns: number,
    rows: number,
    cellWidth?: number,
    cellHeight?: number,
  ): void {
    const message = encodeResizeControlMessage(
      columns,
      rows,
      cellWidth,
      cellHeight,
    );
    this.lastResizeMessage = message;
    this.sendInput(message);
  }

  updateRenderStyle(style: WebHostTerminalStyle): void {
    const message = encodeRenderStyleControlMessage(style);
    this.lastRenderStyleMessage = message;
    this.sendInput(message);
  }

  updatePointerCapabilities(supportsScrollPanning: boolean): void {
    const message = encodePointerCapabilitiesControlMessage(
      supportsScrollPanning,
    );
    this.lastPointerCapabilitiesMessage = message;
    this.sendInput(message);
  }

  sendInput(chunk: Uint8Array): void {
    if (this.disposed) {
      return;
    }

    if (!this.admitsQueuedInput([chunk])) return;
    const copy = new Uint8Array(chunk);
    this.queuedInput.push(copy);
    if (this.socket.readyState === socketOpenState) {
      this.flushQueuedInput();
    }
  }

  requestImagePayloads(ids: readonly string[]): readonly string[] {
    if (this.disposed) {
      return [];
    }
    const acceptedIds = this.decoder.requestImagePayloads(ids);
    this.sendPendingResyncRequests();
    return acceptedIds;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.resetReceiveSession();
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.detachSocket(this.socket);
    this.queuedInput.length = 0;
    this.queuedOutput.length = 0;
    this.queuedOutputBytes = 0;
    this.socket.close(1000, "WebHost scene disposed");
  }

  private attachSocket(socket: WebSocketSceneSocket): void {
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", this.handleOpen);
    socket.addEventListener("message", this.handleMessage);
    socket.addEventListener("close", this.handleClose);
    socket.addEventListener("error", this.handleError);
  }

  private detachSocket(socket: WebSocketSceneSocket): void {
    socket.removeEventListener("open", this.handleOpen);
    socket.removeEventListener("message", this.handleMessage);
    socket.removeEventListener("close", this.handleClose);
    socket.removeEventListener("error", this.handleError);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== undefined) {
      return;
    }
    this.reconnectAttempts += 1;
    const delay = Math.max(
      0,
      this.reconnectDelayMilliseconds(this.reconnectAttempts),
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.reconnect();
    }, delay);
  }

  private reconnect(): void {
    if (this.disposed) {
      return;
    }
    this.detachSocket(this.socket);
    let socket: WebSocketSceneSocket;
    try {
      socket = this.createSocket(this.url);
    } catch {
      // The factory itself failed (e.g. WebSocket unavailable mid-teardown);
      // keep backing off rather than surfacing an exception from a timer.
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    this.attachSocket(socket);
    // A fresh connection is pre-capabilities on the server: the declaration
    // must reach it first (it answers with a keyframe refresh), followed by
    // the last-declared host state. Prepend the handshake so input queued
    // while disconnected flushes after it, preserving the declare-first
    // ordering the constructor establishes.
    const handshake = [encodeCapabilitiesControlMessage()];
    if (this.lastRenderStyleMessage) {
      handshake.push(this.lastRenderStyleMessage);
    }
    if (this.lastResizeMessage) {
      handshake.push(this.lastResizeMessage);
    }
    if (this.lastPointerCapabilitiesMessage) {
      handshake.push(this.lastPointerCapabilitiesMessage);
    }
    if (!this.admitsQueuedInput(handshake)) return;
    this.queuedInput.unshift(
      ...handshake.map((chunk) => new Uint8Array(chunk)),
    );
    if (this.socket.readyState === socketOpenState) {
      this.flushQueuedInput();
    }
  }

  private resetReceiveSession(): void {
    this.receiveGeneration++;
    this.receiveTail = Promise.resolve();
    this.pendingReceives = 0;
    this.pendingReceiveBytes = 0;
    this.decoder = new WebHostOutputDecoder();
    this.queuedOutput.length = 0;
    this.queuedOutputBytes = 0;
    this.sink?.resetSurfaceSession?.();
  }

  private async receive(message: unknown, generation: number): Promise<void> {
    if (this.disposed || generation !== this.receiveGeneration) {
      return;
    }

    // A message may batch records. Match the server's independent 8 MiB
    // envelope ceiling before TextEncoder or Blob.arrayBuffer copies it.
    const limit = HOST_WIRE_MAX_RECORD_BYTES * 2;
    const oversized =
      typeof message === "string"
        ? !fitsUTF8(message, limit)
        : message instanceof ArrayBuffer || ArrayBuffer.isView(message)
          ? message.byteLength > limit
          : typeof Blob !== "undefined" && message instanceof Blob
            ? message.size > limit
            : false;
    const bytes = await (oversized
      ? undefined
      : bytesFromWebSocketMessage(message));
    if (this.disposed || generation !== this.receiveGeneration) return;
    if (oversized) {
      this.deliver(this.decoder.rejectOversizedMessage());
      this.sendPendingResyncRequests();
      return;
    }

    if (!bytes) {
      return;
    }

    for (const record of this.decoder.feed(bytes)) {
      this.deliver(record);
    }
    this.sendPendingResyncRequests();
  }

  private deliver(record: WebHostOutputRecord): void {
    if (this.disposed) return;
    const sink = this.sink;
    if (!sink) {
      const bytes = JSON.stringify(record).length * 2;
      if (
        this.queuedOutput.length >= 256 ||
        this.queuedOutputBytes + bytes > 16 * 1024 * 1024
      ) {
        this.failResourceLimit(
          "WebHost stopped: unbound output exceeded 256 records or 16 MiB. Reload the scene to restart.\n",
        );
        return;
      }
      this.queuedOutputBytes += bytes;
      this.queuedOutput.push(record);
      return;
    }

    switch (record.type) {
      case "surface":
        sink.presentSurface(
          record.frame,
          this.decoder.prepareToPresentSurface(record.frame),
        );
        break;
      case "clipboard":
        void sink.writeClipboard?.(record.text);
        break;
      case "runtimeIssue":
        sink.notifyRuntimeIssue?.(record.issue);
        break;
      case "frameDiagnostic":
        sink.recordFrameDiagnostic?.(record.diagnostic);
        break;
      case "surfaceDropped":
        break;
      case "text":
        sink.writeOutput?.(record.text);
        break;
    }
  }

  private flushQueuedInput(): void {
    if (this.disposed || this.socket.readyState !== socketOpenState) {
      return;
    }
    while (this.queuedInput.length > 0) {
      try {
        this.socket.send(this.queuedInput[0]!);
        this.queuedInput.shift();
      } catch {
        return;
      }
    }
  }

  private failResourceLimit(message: string): void {
    if (this.disposed) return;
    this.resourceFailure = message;
    this.sink?.writeError?.(message);
    this.dispose();
  }

  private admitsQueuedInput(chunks: readonly Uint8Array[]): boolean {
    const bytes = [...this.queuedInput, ...chunks].reduce(
      (total, item) => total + item.byteLength,
      0,
    );
    if (this.queuedInput.length + chunks.length <= 1024 && bytes <= 1024 * 1024)
      return true;
    this.failResourceLimit(
      "WebHost stopped: disconnected input exceeded 1,024 records or 1 MiB. Reload the scene to restart.\n",
    );
    return false;
  }

  private sendPendingResyncRequests(): void {
    while (true) {
      const request = this.decoder.takeResyncRequest();
      if (!request) {
        return;
      }
      try {
        this.sendInput(encodeResyncControlMessage(request));
      } catch {
        this.decoder.resyncRequestDeliveryFailed(request);
        return;
      }
    }
  }
}

export function webSocketSceneURL(
  options: Pick<
    WebSocketSceneBridgeOptions,
    "baseURL" | "webSocketURL" | "sceneId" | "token"
  >,
): URL {
  if (options.webSocketURL) {
    const explicit = new URL(String(options.webSocketURL), currentPageURL());
    explicit.searchParams.set("token", options.token);
    return explicit;
  }

  const url = new URL(
    String(options.baseURL ?? currentPageURL()),
    currentPageURL(),
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const basePath = url.pathname.endsWith("/")
    ? url.pathname.slice(0, -1)
    : url.pathname;
  url.pathname = `${basePath}/ws/scene/${encodeURIComponent(options.sceneId)}`;
  url.search = "";
  url.searchParams.set("token", options.token);
  return url;
}

async function bytesFromWebSocketMessage(
  message: unknown,
): Promise<Uint8Array | undefined> {
  if (typeof message === "string") {
    return textEncoder.encode(message);
  }
  if (message instanceof Uint8Array) {
    return message;
  }
  if (message instanceof ArrayBuffer) {
    return new Uint8Array(message);
  }
  if (ArrayBuffer.isView(message)) {
    return new Uint8Array(
      message.buffer,
      message.byteOffset,
      message.byteLength,
    );
  }
  if (typeof Blob !== "undefined" && message instanceof Blob) {
    return new Uint8Array(await message.arrayBuffer());
  }
  return undefined;
}

function defaultWebSocketFactory(url: string | URL): WebSocketSceneSocket {
  if (typeof WebSocket === "undefined") {
    throw new Error("WebSocket is not available");
  }
  return new WebSocket(url) as WebSocketSceneSocket;
}

function currentPageURL(): string {
  return globalThis.location?.href ?? "http://127.0.0.1/";
}
