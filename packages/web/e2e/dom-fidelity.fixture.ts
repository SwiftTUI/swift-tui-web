import {
  DomSurfacePainter,
  normalizeWebHostTerminalStyle,
  type WebHostSurfaceDamage,
  type WebHostSurfaceFrame,
} from "../dist/index.js";
import { CanvasSurfacePainter } from "../src/CanvasSurfacePainter.ts";

const host = document.createElement("div");
host.style.cssText = "width:400px;height:240px;position:relative";
document.body.replaceChildren(host);
let mutations = 0;
const observer = new MutationObserver((records) => {
  mutations += records.length;
});
observer.observe(host, {
  attributes: true,
  childList: true,
  characterData: true,
  subtree: true,
});
const diagnostics: string[] = [];
const misses: string[][] = [];
const painter = new DomSurfacePainter({
  onResourceLimit: (message) => diagnostics.push(message),
  onImagePayloadMiss: (ids) => {
    misses.push([...ids]);
    return ids;
  },
});
painter.attach(host);
let current: WebHostSurfaceFrame | undefined;
let savedImages: HTMLImageElement[] = [];
let savedLoads: ((event: Event) => unknown)[] = [];
let rowMutations = 0;
let rowObserver: MutationObserver | undefined;
let comparisonCanvas: HTMLCanvasElement | undefined;
let comparisonPainter: CanvasSurfacePainter | undefined;
const api = {
  paint(frame: WebHostSurfaceFrame, damage?: WebHostSurfaceDamage) {
    current = frame;
    painter.paint(
      {
        columns: frame.width,
        rows: frame.height,
        cellWidth: 10,
        cellHeight: 24,
        style: normalizeWebHostTerminalStyle({ fontSize: 16 }),
      },
      frame,
      damage,
    );
  },
  refresh() {
    if (current) api.paint(current);
  },
  compareImage(frame: WebHostSurfaceFrame) {
    api.paint(frame);
    comparisonCanvas = document.createElement("canvas");
    comparisonCanvas.width = 400;
    comparisonCanvas.height = 240;
    host.appendChild(comparisonCanvas);
    comparisonPainter = new CanvasSurfacePainter();
    const paint = () =>
      comparisonPainter!.paint(
        {
          columns: frame.width,
          rows: frame.height,
          cellWidth: 10,
          cellHeight: 24,
          pixelScale: 1,
          style: normalizeWebHostTerminalStyle({ fontSize: 16 }),
        },
        frame,
      );
    comparisonPainter.attach(comparisonCanvas, paint);
    paint();
  },
  imagePixels() {
    const probe = document.createElement("canvas");
    probe.width = probe.height = 1;
    const ctx = probe.getContext("2d")!;
    const image = host.querySelector("img")!;
    ctx.drawImage(image, 0, 0, 1, 1);
    return {
      dom: [...ctx.getImageData(0, 0, 1, 1).data],
      canvas: [
        ...comparisonCanvas!.getContext("2d")!.getImageData(0, 0, 1, 1).data,
      ],
    };
  },
  watchRow(index: number) {
    rowObserver?.disconnect();
    rowMutations = 0;
    rowObserver = new MutationObserver((records) => {
      rowMutations += records.length;
    });
    rowObserver.observe(
      host.querySelectorAll(".webhost-scene__surface-row")[index]!,
      { subtree: true, attributes: true, childList: true, characterData: true },
    );
  },
  state() {
    return {
      stats: painter.statistics,
      systemForeground: getComputedStyle(host).color,
      diagnostics,
      misses,
      mutations,
      rowMutations,
      text: host.textContent,
      cells: [
        ...host.querySelectorAll<HTMLElement>(
          ".webhost-scene__surface-row > *",
        ),
      ].map((cell) => ({
        text: cell.textContent,
        svg: decodeURIComponent(cell.style.backgroundImage),
        color: getComputedStyle(cell).color,
        forcedColorAdjust: cell.style.forcedColorAdjust,
        opacity: cell.style.opacity,
      })),
      images: [...host.querySelectorAll<HTMLImageElement>("img")].map(
        (img) => ({
          src: img.src,
          state: img.parentElement?.dataset.imageState,
          x: img.parentElement?.style.left,
          sameNode: savedImages.includes(img),
        }),
      ),
    };
  },
  saveImages() {
    savedImages = [...host.querySelectorAll<HTMLImageElement>("img")];
    savedLoads = savedImages
      .map((img) => img.onload?.bind(img))
      .filter((callback): callback is (event: Event) => unknown => !!callback);
  },
  lateLoads() {
    for (const callback of savedLoads) callback(new Event("load"));
  },
  dispose() {
    painter.dispose();
    comparisonPainter?.dispose();
    comparisonCanvas?.remove();
  },
};
window.domFidelity = api;
declare global {
  interface Window {
    domFidelity: typeof api;
  }
}
