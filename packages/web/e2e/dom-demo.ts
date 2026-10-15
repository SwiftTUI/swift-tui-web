import { createWebHostApp, DOM_FONT_FAMILY } from "../dist/index.js";
import { createWasmSceneRuntimeFactory } from "../dist/wasi.js";

const status = requiredElement("status");
requiredElement("font-name").textContent = DOM_FONT_FAMILY;

try {
  await createWebHostApp({
    mount: requiredElement("demo"),
    manifestUrl: new URL("/scene-manifest.json", location.href),
    initialSceneId:
      new URLSearchParams(location.search).get("scene") ?? "controls",
    renderer: "dom",
    sceneRuntimeFactory: createWasmSceneRuntimeFactory(
      new URL("/app.wasm", location.href),
      {
        executionMode: "worker",
        workerModuleURL: new URL("/compiled-wasm-worker.js", location.href),
      },
    ),
  });
  status.hidden = true;
} catch (error) {
  status.textContent = `Could not start the demo: ${String(error)}`;
  status.setAttribute("role", "alert");
  console.error(error);
}

function requiredElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing DOM demo element: ${id}`);
  return element;
}
