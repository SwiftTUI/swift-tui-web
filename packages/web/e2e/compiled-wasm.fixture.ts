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
let controller: WebHostAppController | undefined;
let disposed = false;
let jspiStarts = 0;
let jspiSettled = 0;

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
        frames[sceneId] = frame;
        frameCounts[sceneId] = (frameCounts[sceneId] ?? 0) + 1;
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
    };
  },
  async start(mode: "worker" | "main-thread") {
    if (controller) throw new Error("The compiled WASM app is already started");
    controller = await createWebHostApp({
      mount: requiredElement("wasm-mount"),
      manifestUrl: new URL("/scene-manifest.json", location.href),
      initialSceneId: "alpha",
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
          workerModuleURL: new URL("/compiled-wasm-worker.js", location.href),
        },
      ),
    });
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
