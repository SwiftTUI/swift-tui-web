import {
  BrowserWASIBridge,
  DomSurfacePainter,
  normalizeWebHostTerminalStyle,
  type SurfaceMetrics,
  WebHostSceneRuntime,
  type WebHostSurfaceFrame,
} from "../dist/index.js";
import { CanvasSurfacePainter } from "../src/CanvasSurfacePainter.ts";

const textDecoder = new TextDecoder();
const mount = document.createElement("div");
mount.style.cssText = "width:900px;height:400px";
document.body.replaceChildren(mount);
const bridge = new BrowserWASIBridge({ sceneId: "dom", columns: 60, rows: 10 });
const inputs: string[] = [];
const opened: string[] = [];
const runtime = new WebHostSceneRuntime({
  mount,
  descriptor: { id: "dom", isDefault: true },
  renderer: "dom",
  bridge,
  style: { fontFamily: "monospace", fontSize: 16 },
  synchronizeAccessibilityFocus: false,
  onInput: (chunk) => inputs.push(textDecoder.decode(chunk)),
  onOpenHyperlink: (url) => opened.push(url),
});
await runtime.mount();
runtime.setVisible(true);
const frame: WebHostSurfaceFrame = {
  version: 2,
  width: 60,
  height: 10,
  styles: [null, { fg: "#ff0000", em: 16 }],
  rows: [
    [
      [0, "Select me", 9, 0],
      [12, "counter", 7, 0],
    ],
    [[0, "other", 5, 0]],
    [
      [0, "漢", 2, 0],
      [2, "🙂", 2, 0],
      [4, "Link", 4, 0],
    ],
    [[0, "W".repeat(55), 55, 0]],
    [..."┌─┬━┓│╋╬╰╱█▚⠁⠿⣿"].map((c, x) => [x, c, 1, 0]),
  ],
  links: [[2, [[4, 4, 0]]]],
  linkTargets: ["https://example.com/swifttui"],
  images: [
    {
      id: "dom-image",
      format: "png",
      bounds: [20, 2, 4, 2],
      visibleBounds: [21, 2, 3, 2],
      scalingMode: "stretch",
      opacity: 0.5,
      dataBase64:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=",
    },
  ],
};
async function present() {
  bridge.stdout.write(`\u001Esurface:${JSON.stringify(frame)}\n`);
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}
await present();
const root = mount.querySelector<HTMLElement>(".webhost-scene__surface--dom")!;
const row = (y: number) =>
  root.querySelectorAll<HTMLElement>(".webhost-scene__surface-row")[y]!;
const firstNode = row(0).firstElementChild!.firstChild;
let copied = "";
let copyShortcutPrevented: boolean | null = null;
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
    copyShortcutPrevented = event.defaultPrevented;
  }
});
document.addEventListener("copy", () => {
  copied = document.getSelection()?.toString() ?? "";
});
const api = {
  copyCorpus() {
    const host = document.createElement("div");
    host.id = "copy-corpus";
    host.tabIndex = 0;
    host.style.cssText = "position:relative;width:120px;height:48px";
    document.body.append(host);
    host.focus();
    const painter = new DomSurfacePainter();
    painter.attach(host);
    painter.paint(
      {
        columns: 12,
        rows: 2,
        cellWidth: 10,
        cellHeight: 24,
        style: normalizeWebHostTerminalStyle({ fontSize: 16 }),
      },
      {
        version: 2,
        width: 12,
        height: 2,
        styles: [null],
        rows: [
          [
            [2, "A", 1, 0],
            [3, "🙂", 2, 0],
            [7, "é", 1, 0],
            [8, "B", 1, 0],
          ],
          [
            [0, "<script>", 8, 0],
            [10, "漢", 2, 0],
          ],
        ],
      },
    );
    const range = document.createRange();
    range.selectNodeContents(host);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    return {
      text: host.textContent,
      selected: selection.toString(),
      scripts: host.querySelectorAll("script").length,
    };
  },
  linkPolicies() {
    const metrics: SurfaceMetrics = {
      columns: 12,
      rows: 1,
      cellWidth: 10,
      cellHeight: 22,
      style: normalizeWebHostTerminalStyle({}),
    };
    const f: WebHostSurfaceFrame = {
      version: 2,
      width: 12,
      height: 1,
      styles: [null],
      rows: [
        [
          [0, "web", 3, 0],
          [4, "unsafe", 6, 0],
        ],
      ],
      links: [
        [
          0,
          [
            [0, 3, 0],
            [4, 6, 1],
          ],
        ],
      ],
      linkTargets: ["https://example.test/target", "javascript:alert(1)"],
    };
    const plain = document.createElement("div");
    plain.id = "policy-links";
    plain.style.cssText = "width:120px;height:22px";
    document.body.append(plain);
    const painter = new DomSurfacePainter();
    painter.attach(plain);
    painter.paint(metrics, f);
    const custom = document.createElement("div");
    custom.id = "hook-links";
    custom.style.cssText = "width:120px;height:22px";
    document.body.append(custom);
    const hooked = new DomSurfacePainter({
      onOpenHyperlink: (url) => opened.push(url),
    });
    hooked.attach(custom);
    hooked.paint(metrics, {
      ...f,
      linkTargets: ["app:document/7", "javascript:alert(1)"],
    });
  },
  async update(kind: string) {
    if (kind === "other-row") frame.rows[1] = [[0, "updated", 7, 0]];
    if (kind === "same-row") frame.rows[0]![1] = [12, "changed", 7, 0];
    if (kind === "cosmetic") frame.styles = [null, { fg: "#00ff00", em: 3 }];
    if (kind === "cosmetic") frame.rows[0]![0]![3] = 1;
    if (kind === "selected") frame.rows[0]![0]![1] = "REPLACED!";
    if (kind === "removed") frame.rows[0] = [];
    if (kind === "remove-leading")
      frame.rows[0] = frame.rows[0]?.slice(1) ?? [];
    if (kind === "shrink") {
      frame.rows = [];
      frame.height = 1;
      frame.images = undefined;
      frame.links = undefined;
      frame.linkTargets = undefined;
    }
    // Full frames deliberately test the most aggressive repaint path, while
    // explicit row damage checks the retained-frame delta path below.
    frame.damage =
      kind === "other-row" || kind === "same-row"
        ? {
            textRows: [[kind === "other-row" ? 1 : 0, []]],
            requiresFullTextRepaint: false,
            requiresFullGraphicsReplay: false,
          }
        : undefined;
    await present();
  },
  select(index = 0) {
    const selection = document.getSelection()!;
    const text = row(0).children[index]!.firstChild!;
    selection.setBaseAndExtent(text, 0, text, text.textContent!.length);
  },
  state() {
    return {
      selected: document.getSelection()?.toString(),
      sameNode: row(0)?.firstElementChild?.firstChild === firstNode,
      copied,
      copyShortcutPrevented,
      inputs,
      opened,
      text: root.textContent,
      anchors: root.querySelectorAll("a").length,
    };
  },
  async restyle() {
    runtime.setStyle({ fontFamily: "monospace", fontSize: 19 });
    await present();
  },
  async resize(zoom: number) {
    mount.style.width = "700px";
    mount.style.zoom = String(zoom);
    window.dispatchEvent(new Event("resize"));
    await present();
  },
  geometry() {
    const cells = Array.from(row(2).children).map((e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    const run = row(3).firstElementChild!;
    const range = document.createRange();
    range.selectNodeContents(run);
    return {
      cells,
      image: (() => {
        const image = root.querySelector("img")!;
        const r = image.getBoundingClientRect();
        const clip = image.parentElement!.getBoundingClientRect();
        return {
          width: r.width,
          clipWidth: clip.width,
          opacity: getComputedStyle(image).opacity,
          naturalWidth: image.naturalWidth,
        };
      })(),
      textWidth: range.getBoundingClientRect().width,
      runWidth: run.getBoundingClientRect().width,
    };
  },
  async glyphs(width: number, height: number) {
    const host = document.createElement("div");
    host.style.cssText = "position:relative";
    document.body.append(host);
    const dom = document.createElement("div");
    host.append(dom);
    const canvas = document.createElement("canvas");
    host.append(canvas);
    const texts = [..."┌─┬━┓│╋╬╰╱█▚⠁⠿⣿"];
    const metrics: SurfaceMetrics = {
      columns: texts.length,
      rows: 1,
      cellWidth: width,
      cellHeight: height,
      pixelScale: devicePixelRatio,
      style: normalizeWebHostTerminalStyle({
        theme: { foreground: "#ff8000", background: "#000000" },
      }),
    };
    canvas.width = Math.ceil(width * texts.length * devicePixelRatio);
    canvas.height = Math.ceil(height * devicePixelRatio);
    dom.style.width = `${width * texts.length}px`;
    dom.style.height = `${height}px`;
    const f: WebHostSurfaceFrame = {
      version: 2,
      width: texts.length,
      height: 1,
      styles: [null],
      rows: [texts.map((t, x) => [x, t, 1, 0])],
    };
    const dp = new DomSurfacePainter();
    dp.attach(dom);
    dp.paint(metrics, f);
    const cp = new CanvasSurfacePainter();
    cp.attach(canvas, () => {});
    cp.paint(metrics, f);
    // Rasterize SVG backgrounds using the engine's own image decoder and
    // compare geometry to Canvas separately from font/selection rendering.
    const actual = document.createElement("canvas");
    actual.width = canvas.width;
    actual.height = canvas.height;
    const context = actual.getContext("2d")!;
    context.fillStyle = "#000000";
    context.fillRect(0, 0, actual.width, actual.height);
    context.scale(devicePixelRatio, devicePixelRatio);
    const elements = Array.from(
      dom.querySelectorAll<HTMLElement>(".webhost-scene__surface-row > *"),
    );
    for (const [x, element] of elements.entries()) {
      const img = new Image();
      img.src = element.style.backgroundImage.slice(5, -2);
      await img.decode();
      context.drawImage(img, x * width, 0, width, height);
    }
    const expected = canvas
      .getContext("2d")!
      .getImageData(0, 0, canvas.width, canvas.height).data;
    const rendered = context.getImageData(
      0,
      0,
      canvas.width,
      canvas.height,
    ).data;
    let different = 0,
      total = 0;
    for (let i = 0; i < expected.length; i += 4) {
      if (expected[i] || rendered[i]) total++;
      if (Math.abs(expected[i]! - rendered[i]!) > 30) different++;
    }
    return { different, total, text: dom.textContent, count: elements.length };
  },
};
window.domJourney = api;
declare global {
  interface Window {
    domJourney: typeof api;
  }
}
