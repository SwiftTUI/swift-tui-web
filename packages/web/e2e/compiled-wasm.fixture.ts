import {
  BrowserWASIBridge,
  type BrowserWASIOutputSink,
  createWebHostApp,
  type WebHostAppController,
  type WebHostSurfaceFrame,
} from "../dist/index.js";
import {
  collectWasmEngineProbeSignals,
  createWasmSceneRuntimeFactory,
  jspiConstructors,
  resolveWasmEngineCapabilities,
  resolveWasmExecutionMode,
} from "../dist/wasi.js";

const capabilities = {
  ...resolveWasmEngineCapabilities(),
  signals: collectWasmEngineProbeSignals(),
  crossOriginIsolated,
  sharedArrayBuffer: typeof SharedArrayBuffer === "function",
  userAgent: navigator.userAgent,
};
const frames: Record<string, WebHostSurfaceFrame> = {};
const frameCounts: Record<string, number> = {};
const errors: string[] = [];
const bridges: ObservedBridge[] = [];
const runtimes: import("../dist/index.js").WebHostSceneRuntime[] = [];
const inputSent = new Map<number, number>();
const inputLatencies: number[] = [];
let measuring = false;
const heartbeats: number[] = [];
let lastHeartbeat = performance.now();
setInterval(() => {
  const now = performance.now();
  if (measuring) heartbeats.push(now - lastHeartbeat);
  lastHeartbeat = now;
}, 10);
let controller: WebHostAppController | undefined;
let disposed = false;
let jspiStarts = 0;
let jspiSettled = 0;
let animationFrame = 0;
const geometryTimings: {
  revision: number;
  sent: number;
  animationFrame: number;
  received?: number;
  painted?: number;
}[] = [];
const sentInputs: string[] = [];
let finalSizeDelivered = 0;
function observeAnimationFrame() {
  animationFrame++;
  const revision = runtimes[0]?.geometrySnapshot?.sourceRevision;
  const timing = geometryTimings.find((item) => item.revision === revision);
  if (timing && timing.painted === undefined)
    timing.painted = performance.now();
  if (!disposed) requestAnimationFrame(observeAnimationFrame);
}
requestAnimationFrame(observeAnimationFrame);

// Observe the real export promise so teardown proves the WASM invocation
// returned, even after its bridge has been closed. Execution is unchanged.
const jspi = jspiConstructors();
if (jspi) {
  const promising = jspi.promising.bind(WebAssembly);
  jspi.promising = (fn) => {
    const invoke = promising(fn);
    return (...args) => {
      jspiStarts += 1;
      return invoke(...args).finally(() => {
        jspiSettled += 1;
      });
    };
  };
}

// Observe frames at the production bridge's output boundary. All records are
// produced by the compiled Swift app and presented by the real browser host.
class ObservedBridge extends BrowserWASIBridge {
  override bindOutput(sink: BrowserWASIOutputSink): void {
    const sceneId = this.environment.SWIFTTUI_SCENE;
    if (!sceneId) throw new Error("Missing WASI scene identifier");
    super.bindOutput({
      ...sink,
      presentSurface(frame, recovered) {
        const timing = geometryTimings.find(
          (item) => item.revision === frame.geometryRevision,
        );
        if (timing && timing.received === undefined)
          timing.received = performance.now();
        frames[sceneId] = frame;
        frameCounts[sceneId] = (frameCounts[sceneId] ?? 0) + 1;
        const text = frame.rows
          .map((row) => row.map((cell) => cell[1]).join(""))
          .join("\n");
        const count = Number(/(?:Alpha|Deep) count (\d+)/.exec(text)?.[1]);
        const sent = inputSent.get(count);
        if (sent !== undefined) {
          inputLatencies.push(performance.now() - sent);
          inputSent.delete(count);
        }
        sink.presentSurface(frame, recovered);
      },
      writeError(message) {
        errors.push(message);
        sink.writeError?.(message);
      },
      notifyRuntimeIssue(issue) {
        errors.push(issue.description);
        sink.notifyRuntimeIssue?.(issue);
      },
    });
  }
}

const api = {
  probeVariants() {
    const actual = collectWasmEngineProbeSignals();
    const variants = [
      {
        ...actual,
        errorStack: "",
        errorHasGeckoFileName: false,
        errorHasJSCSourceURL: false,
      },
      {
        ...actual,
        errorStack: "fn@url:1:2",
        errorHasGeckoFileName: false,
        errorHasJSCSourceURL: false,
      },
      {
        ...actual,
        errorStack: "    at fn (url:1:2)",
        errorHasGeckoFileName: true,
        errorHasJSCSourceURL: true,
      },
    ].map(resolveWasmEngineCapabilities);
    return {
      actual,
      variants,
      autoWorker: resolveWasmExecutionMode("auto", capabilities, true),
      autoWithoutSAB: resolveWasmExecutionMode("auto", capabilities, false),
      forcedWorker: resolveWasmExecutionMode("worker", capabilities, false),
      forcedMain: resolveWasmExecutionMode("main-thread", capabilities, true),
    };
  },
  snapshot() {
    return {
      capabilities,
      ready: controller !== undefined,
      selectedSceneId: controller?.selectedSceneId,
      scenes: controller?.scenes.map((scene) => scene.id) ?? [],
      createdScenes: bridges.map((bridge) => bridge.environment.SWIFTTUI_SCENE),
      frames,
      frameCounts,
      errors,
      disposed,
      jspiStarts,
      jspiSettled,
      environments: bridges.map((b) => b.environment),
      inputLatencies,
      heartbeats,
      paints: runtimes.map((r) => r.paintStatistics),
      geometry: runtimes.map((r) => r.geometrySnapshot),
      geometryTimings,
      sentInputs,
      finalSizeDelivered,
    };
  },
  async start(
    mode: "worker" | "main-thread" | "auto",
    scene = "alpha",
    environment?: Record<string, string>,
    renderer: "canvas" | "dom" = "canvas",
  ) {
    if (controller) throw new Error("The compiled WASM app is already started");
    controller = await createWebHostApp({
      mount: requiredElement("wasm-mount"),
      manifestUrl: new URL("/scene-manifest.json", location.href),
      initialSceneId: scene,
      environment,
      renderer,
      bridgeFactory(options) {
        const bridge = new ObservedBridge({
          sceneId: options.sceneId,
          environment: options.environment,
          renderStyle: options.style,
          columns: 64,
          rows: 12,
        });
        bridges.push(bridge);
        return bridge;
      },
      sceneRuntimeFactory: createWasmSceneRuntimeFactory(
        new URL("/app.wasm", location.href),
        {
          executionMode: mode,
          onRuntimeCreated: (runtime) => {
            runtimes.push(
              runtime as import("../dist/index.js").WebHostSceneRuntime,
            );
            // Test-only observation of the actual input routing boundary.
            // Forward every byte unchanged into the production shared queue.
            const observed = runtime as unknown as {
              onInput(chunk: Uint8Array): void;
            };
            const send = observed.onInput.bind(runtime);
            observed.onInput = (chunk) => {
              const text = new TextDecoder().decode(chunk);
              sentInputs.push(text);
              const revision = /^geometry:(\d+):/.exec(text.slice(1))?.[1];
              if (revision)
                geometryTimings.push({
                  revision: Number(revision),
                  sent: performance.now(),
                  animationFrame,
                });
              send(chunk);
            };
          },
          workerModuleURL: new URL("/compiled-wasm-worker.js", location.href),
        },
      ),
    });
  },
  setFontSize(fontSize: number) {
    for (const runtime of runtimes) runtime.setStyle({ fontSize });
  },
  resizeMount(width: number, height: number) {
    const mount = requiredElement("wasm-mount");
    mount.style.width = `${width}px`;
    mount.style.height = `${height}px`;
    for (const runtime of runtimes) runtime.refreshGeometry();
    finalSizeDelivered = performance.now();
  },
  beginSample() {
    inputLatencies.length = 0;
    heartbeats.length = 0;
    inputSent.clear();
    measuring = true;
    lastHeartbeat = performance.now();
  },
  endSample() {
    measuring = false;
  },
  markInput(count: number) {
    inputSent.set(count, performance.now());
  },
  suspend(value: boolean) {
    for (const runtime of runtimes) runtime.setDocumentVisible(!value);
  },
  async dispose() {
    await controller?.dispose();
    disposed = true;
  },
};

declare global {
  interface Window {
    __compiledWasm: typeof api;
  }
}
window.__compiledWasm = api;

for (const id of ["alpha", "beta"]) {
  requiredElement(id).onclick = () => {
    void controller
      ?.switchScene(id)
      .catch((error: unknown) => errors.push(String(error)));
  };
}
requiredElement("dispose").onclick = () => {
  void controller?.dispose().then(() => {
    disposed = true;
  });
};

function requiredElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing WASM fixture element: ${id}`);
  return element;
}

requiredElement("start-accessibility").onclick = () => {
  void api
    .start("worker", "accessibility")
    .catch((error: unknown) => errors.push(String(error)));
};
