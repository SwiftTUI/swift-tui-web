import { expect, test } from "bun:test";

import { createWebHostApp, type WebHostAppOptions } from "./WebHostApp.ts";
import type { WebSocketSceneSocket } from "./WebSocketSceneBridge.ts";
import type {
  ResolvedWebHostTerminalStyle,
  WebHostTerminalStyle,
} from "./WebHostTerminalStyle.ts";
import type { WebHostSceneRuntimeOptions } from "./WebHostSceneRuntime.ts";

class FakeRuntime {
  readonly descriptorId: string;
  mountCount = 0;
  visible = false;
  styleUpdates: Array<WebHostTerminalStyle | ResolvedWebHostTerminalStyle> = [];
  disposed = false;

  constructor(descriptorId: string) {
    this.descriptorId = descriptorId;
  }

  async mount(): Promise<void> {
    this.mountCount += 1;
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
  }

  setStyle(
    style: WebHostTerminalStyle | ResolvedWebHostTerminalStyle
  ): void {
    this.styleUpdates.push(style);
  }

  resize(_columns: number, _rows: number): void {}

  writeOutput(_text: string): void {}

  sendInput(_chunk: Uint8Array): void {}

  documentVisible = true;

  setDocumentVisible(visible: boolean): void {
    this.documentVisible = visible;
  }

  dispose(): void {
    this.disposed = true;
  }
}

test("app controller switches scenes and propagates active styles", async () => {
  const runtimes = new Map<string, FakeRuntime>();
  const seenRuntimeOptions = new Map<string, WebHostSceneRuntimeOptions>();
  const mount = makeElement("div");
  const options: WebHostAppOptions = {
    mount: mount as unknown as HTMLElement,
    manifest: {
      defaultSceneId: "dashboard",
      scenes: [
        { id: "dashboard", title: "Dashboard", isDefault: true },
        { id: "controls", title: "Controls", isDefault: false },
      ],
    },
    style: {
      theme: {
        foreground: "#111111",
        background: "#f0f0f0",
        tint: "#0057b8",
        separator: "#cccccc",
        selection: "#ddeeff",
        placeholder: "#666666",
        link: "#0057b8",
        fill: "#f7f7f7",
        windowBackground: "#ffffff",
        success: "#1a7f37",
        warning: "#9a6700",
        danger: "#cf222e",
        info: "#0969da",
        muted: "#57606a",
      },
    },
    createElement: (tagName: string) => makeElement(tagName) as unknown as HTMLElement,
    sceneRuntimeFactory: (runtimeOptions: WebHostSceneRuntimeOptions) => {
      const runtime = new FakeRuntime(runtimeOptions.descriptor.id);
      runtimes.set(runtimeOptions.descriptor.id, runtime);
      seenRuntimeOptions.set(runtimeOptions.descriptor.id, runtimeOptions);
      return runtime as unknown as never;
    },
  };

  const controller = await createWebHostApp(options);
  const dashboardRuntime = runtimes.get("dashboard");
  const dashboardOptions = seenRuntimeOptions.get("dashboard");

  expect(controller.selectedSceneId).toBe("dashboard");
  expect(dashboardOptions?.style.theme?.background).toBe("#f0f0f0");
  expect(dashboardRuntime?.visible).toBe(true);
  expect(dashboardRuntime?.mountCount).toBe(1);

  await controller.switchScene("controls");
  const controlsRuntime = runtimes.get("controls");

  expect(controller.selectedSceneId).toBe("controls");
  expect(dashboardRuntime?.visible).toBe(false);
  expect(controlsRuntime?.visible).toBe(true);
  expect(controlsRuntime?.mountCount).toBe(1);

  await controller.switchScene("dashboard");
  expect(runtimes.get("dashboard")).toBe(dashboardRuntime);
  expect(dashboardRuntime?.mountCount).toBe(1);

  controller.setStyle({
    cursorBlink: true,
  });

  expect(dashboardRuntime?.styleUpdates.at(-1)?.cursorBlink).toBe(true);
  expect(controlsRuntime?.styleUpdates.at(-1)?.cursorBlink).toBe(true);

  await controller.dispose();
  expect(dashboardRuntime?.disposed).toBe(true);
  expect(controlsRuntime?.disposed).toBe(true);
});

test("app controller uses the embedded WebSocket bridge when configured", async () => {
  const socket = new FakeSocket();
  let socketURL = "";
  let runtimeOptions: WebHostSceneRuntimeOptions | undefined;
  const mount = makeElement("div");

  const controller = await createWebHostApp({
    mount: mount as unknown as HTMLElement,
    manifest: {
      defaultSceneId: "main",
      scenes: [{ id: "main", title: "Main", isDefault: true }],
    },
    embeddedHost: {
      token: "test-token",
      webSocketBaseURL: "http://127.0.0.1:9123/",
      webSocketFactory: (url) => {
        socketURL = String(url);
        return socket;
      },
    },
    createElement: (tagName: string) => makeElement(tagName) as unknown as HTMLElement,
    sceneRuntimeFactory: (options: WebHostSceneRuntimeOptions) => {
      runtimeOptions = options;
      return new FakeRuntime(options.descriptor.id) as unknown as never;
    },
  });

  expect(socketURL).toBe("ws://127.0.0.1:9123/ws/scene/main?token=test-token");

  socket.open();
  runtimeOptions?.onInput(new TextEncoder().encode("input-record"));
  expect(new TextDecoder().decode(socket.sent[0])).toBe("input-record");

  await controller.dispose();
  expect(socket.closed).toBe(true);
});

function makeElement(
  tagName: string
): Record<string, unknown> {
  return {
    tagName,
    className: "",
    dataset: {},
    hidden: false,
    style: {},
    replaceChildren: () => {},
    appendChild: () => {},
    remove: () => {},
    hasAttribute: () => false,
    setAttribute: () => {},
  };
}

class FakeSocket implements WebSocketSceneSocket {
  binaryType: BinaryType = "blob";
  readyState = 0;
  readonly sent: Uint8Array[] = [];
  closed = false;

  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  send(
    data: string | ArrayBufferLike | Blob | ArrayBufferView
  ): void {
    if (typeof data === "string") {
      this.sent.push(new TextEncoder().encode(data));
    } else if (data instanceof Uint8Array) {
      this.sent.push(new Uint8Array(data));
    } else if (data instanceof ArrayBuffer) {
      this.sent.push(new Uint8Array(data));
    } else if (ArrayBuffer.isView(data)) {
      this.sent.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    }
  }

  close(): void {
    this.closed = true;
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
    for (const listener of this.listeners.get("open") ?? []) {
      listener({});
    }
  }
}

test("app controller forwards document visibility to every scene runtime", async () => {
  const runtimes = new Map<string, FakeRuntime>();
  const seenRuntimeOptions = new Map<string, WebHostSceneRuntimeOptions>();
  const listeners = new Set<() => void>();
  const visibilityDocument = {
    hidden: false,
    addEventListener: (_type: "visibilitychange", listener: () => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: "visibilitychange", listener: () => void) => {
      listeners.delete(listener);
    },
  };
  const mount = makeElement("div");

  const controller = await createWebHostApp({
    mount: mount as unknown as HTMLElement,
    manifest: {
      defaultSceneId: "dashboard",
      scenes: [
        { id: "dashboard", title: "Dashboard", isDefault: true },
        { id: "controls", title: "Controls", isDefault: false },
      ],
    },
    createElement: (tagName: string) => makeElement(tagName) as unknown as HTMLElement,
    sceneRuntimeFactory: (runtimeOptions: WebHostSceneRuntimeOptions) => {
      const runtime = new FakeRuntime(runtimeOptions.descriptor.id);
      runtimes.set(runtimeOptions.descriptor.id, runtime);
      seenRuntimeOptions.set(runtimeOptions.descriptor.id, runtimeOptions);
      return runtime as unknown as never;
    },
    visibilityDocument,
  });

  expect(listeners.size).toBe(1);
  expect(runtimes.get("dashboard")?.documentVisible).toBe(true);
  expect(seenRuntimeOptions.get("dashboard")?.suspendWhenHidden).toBeUndefined();

  visibilityDocument.hidden = true;
  for (const listener of [...listeners]) {
    listener();
  }
  expect(runtimes.get("dashboard")?.documentVisible).toBe(false);

  // A runtime created while the document is hidden learns that immediately.
  await controller.switchScene("controls");
  expect(runtimes.get("controls")?.documentVisible).toBe(false);

  visibilityDocument.hidden = false;
  for (const listener of [...listeners]) {
    listener();
  }
  expect(runtimes.get("dashboard")?.documentVisible).toBe(true);
  expect(runtimes.get("controls")?.documentVisible).toBe(true);

  await controller.dispose();
  expect(listeners.size).toBe(0);
});

test("app controller forwards suspendHiddenScenes to runtime options", async () => {
  const seenRuntimeOptions = new Map<string, WebHostSceneRuntimeOptions>();
  const mount = makeElement("div");

  const controller = await createWebHostApp({
    mount: mount as unknown as HTMLElement,
    manifest: {
      defaultSceneId: "main",
      scenes: [{ id: "main", title: "Main", isDefault: true }],
    },
    createElement: (tagName: string) => makeElement(tagName) as unknown as HTMLElement,
    sceneRuntimeFactory: (runtimeOptions: WebHostSceneRuntimeOptions) => {
      seenRuntimeOptions.set(runtimeOptions.descriptor.id, runtimeOptions);
      return new FakeRuntime(runtimeOptions.descriptor.id) as unknown as never;
    },
    suspendHiddenScenes: false,
  });

  expect(seenRuntimeOptions.get("main")?.suspendWhenHidden).toBe(false);
  await controller.dispose();
});

test("app controller forwards the renderer choice to every scene runtime", async () => {
  const seenRuntimeOptions: WebHostSceneRuntimeOptions[] = [];
  const mount = makeElement("div");
  const controller = await createWebHostApp({
    mount: mount as unknown as HTMLElement,
    manifest: {
      defaultSceneId: "main",
      scenes: [
        { id: "main", title: "Main", isDefault: true },
        { id: "second", title: "Second", isDefault: false },
      ],
    },
    renderer: "dom",
    createElement: (tagName: string) => makeElement(tagName) as unknown as HTMLElement,
    sceneRuntimeFactory: (runtimeOptions: WebHostSceneRuntimeOptions) => {
      seenRuntimeOptions.push(runtimeOptions);
      return new FakeRuntime(runtimeOptions.descriptor.id) as unknown as never;
    },
  });

  await controller.switchScene("second");
  expect(seenRuntimeOptions).toHaveLength(2);
  expect(seenRuntimeOptions.every((options) => options.renderer === "dom")).toBe(true);
  await controller.dispose();
});
