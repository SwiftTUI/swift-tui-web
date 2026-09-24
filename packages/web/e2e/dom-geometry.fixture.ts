import {
  BrowserWASIBridge,
  type DomFontOptions,
  WebHostSceneRuntime,
} from "../dist/index.js";

HTMLCanvasElement.prototype.getContext = () => {
  throw new Error("DOM mode requested Canvas");
};
document.body.replaceChildren();
const runtimes: {
  runtime: WebHostSceneRuntime;
  mount: HTMLElement;
  bridge: BrowserWASIBridge;
  inputs: string[];
}[] = [];
const api = {
  async create(
    font: DomFontOptions = { assetBase: "/fonts/" },
    hidden = false,
    sceneFrame: "fill" | "resizable" = "fill",
  ) {
    const mount = document.createElement("div");
    mount.style.cssText = `width:2800.5px;height:400.25px;${hidden ? "display:none" : ""}`;
    document.body.append(mount);
    const id = runtimes.length;
    const bridge = new BrowserWASIBridge({
      sceneId: `geometry-${id}`,
      columns: 201,
      rows: 8,
    });
    const inputs: string[] = [];
    mount.addEventListener(
      "pointerdown",
      (event) => inputs.push(`client:${event.clientX}:${event.clientY}`),
      true,
    );
    bridge.stdin.subscribe((data) => {
      inputs.push(new TextDecoder().decode(data));
    });
    const resize = bridge.resize.bind(bridge);
    bridge.resize = (...args) => {
      inputs.push(`resize:${args.join(":")}`);
      resize(...args);
    };
    const runtime = new WebHostSceneRuntime({
      mount,
      descriptor: { id: `geometry-${id}`, isDefault: true },
      style: { fontSize: 16 },
      renderer: "dom",
      domFont: font,
      bridge,
      sceneFrame,
      onInput: (data) => inputs.push(new TextDecoder().decode(data)),
      synchronizeAccessibilityFocus: false,
    });
    runtimes.push({ mount, runtime, bridge, inputs });
    await runtime.mount();
    runtime.setVisible(true);
    return id;
  },
  async ready(id: number) {
    await runtimes[id]!.runtime.fontReady;
    await new Promise(requestAnimationFrame);
  },
  present(id: number) {
    const { bridge, runtime } = runtimes[id]!;
    const geometry = runtime.geometrySnapshot;
    const width = geometry?.columns ?? 201,
      height = Math.min(8, geometry?.rows ?? 8);
    bridge.stdout.write(
      `\u001esurface:${JSON.stringify({ version: 2, width, height, styles: [null], rows: Array.from({ length: height }, () => Array.from({ length: width }, (_, x) => [x, "W", 1, 0])) })}\n`,
    );
  },
  state(id: number) {
    const { runtime, inputs, mount } = runtimes[id]!;
    const root = mount.querySelector(".webhost-scene__surface--dom");
    return {
      font: runtime.fontStatus,
      geometry: runtime.geometrySnapshot,
      inputs: [...inputs],
      text: root?.textContent,
      busy: runtime.terminalMount.getAttribute("aria-busy"),
      faces: [...document.fonts].filter((face) =>
        face.family.startsWith("SwiftTUIFont"),
      ).length,
      status: mount.querySelector('[role="status"]')?.textContent,
    };
  },
  style(id: number, css: string, terminalCSS = "") {
    const { mount, runtime } = runtimes[id]!;
    mount.style.cssText = css;
    if (terminalCSS) runtime.terminalMount.style.cssText += terminalCSS;
    runtime.refreshGeometry();
  },
  async settle() {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
  },
  setFont(id: number, fontSize: number, fontFamily?: string) {
    runtimes[id]!.runtime.setStyle({ fontSize, fontFamily });
  },
  clientPoint(id: number, x: number, y: number) {
    const { mount } = runtimes[id]!;
    const surface = mount.querySelector(".webhost-scene__surface--dom")!;
    const rect = surface.getBoundingClientRect();
    const g = runtimes[id]!.runtime.geometrySnapshot!;
    return {
      x: rect.left + (x * rect.width) / g.columns,
      y: rect.top + (y * rect.height) / g.rows,
    };
  },
  dispose(id: number) {
    runtimes[id]!.runtime.dispose();
  },
};
window.domGeometryJourney = api;
declare global {
  interface Window {
    domGeometryJourney: typeof api;
  }
}
