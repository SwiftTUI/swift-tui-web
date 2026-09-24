import {
  DOM_FONT_FACES,
  DomSurfacePainter,
  normalizeWebHostTerminalStyle,
  type WebHostSurfaceDamage,
  type WebHostSurfaceFrame,
} from "../dist/index.js";

HTMLCanvasElement.prototype.getContext = () => {
  throw new Error("DOM benchmark requested Canvas");
};
await Promise.all(
  DOM_FONT_FACES.map(async (face) => {
    const font = new FontFace(
      "SwiftTUI Performance",
      `url(/fonts/${face.file})`,
      { weight: face.weight, style: face.style },
    );
    await font.load();
    document.fonts.add(font);
  }),
);
const style = normalizeWebHostTerminalStyle({
  fontSize: 16,
  fontFamily: '"SwiftTUI Performance", monospace',
});
const raf = () => new Promise<number>(requestAnimationFrame);
const api = {
  async measure(
    width: number,
    height: number,
    partial: boolean,
    repeat: number,
  ) {
    const mount = document.createElement("div");
    mount.style.cssText = `width:${width * 10}px;height:${height * 24}px`;
    document.body.replaceChildren(mount);
    const painter = new DomSurfacePainter();
    painter.attach(mount);
    const metrics = {
      columns: width,
      rows: height,
      cellWidth: 10,
      cellHeight: 24,
      style,
    };
    const frames: WebHostSurfaceFrame[] = [0, 1].map((phase) => ({
      version: 2,
      width,
      height,
      styles: [
        null,
        { em: 1, fg: "#e6c07b" },
        { em: 2, fg: "#56b6c2" },
        { em: 3, fg: "#c678dd" },
      ],
      rows: Array.from({ length: height }, (_, y) =>
        Array.from({ length: width }, (_, x) => [
          x,
          (partial && x % 10 !== 0) || !phase ? "a" : "b",
          1,
          width === 240 ? (x + y) % 4 : 0,
        ]),
      ),
    }));
    const damage: WebHostSurfaceDamage | undefined = partial
      ? {
          textRows: Array.from({ length: height }, (_, y) => [y, [[0, width]]]),
          requiresFullTextRepaint: false,
          requiresFullGraphicsReplay: false,
        }
      : undefined;
    painter.paint(metrics, frames[0]);
    const retained = mount.querySelector(".webhost-scene__surface-row span");
    const samples = [];
    for (let index = -5; index < 10; index++) {
      await raf();
      const label = `dom-${width}-${partial ? "partial" : "full"}-${repeat}-${index}`;
      if (index >= 0) performance.mark(`${label}-start`);
      const start = performance.now();
      painter.paint(metrics, frames[Math.abs(index) % 2], damage);
      const js = performance.now() - start;
      mount.lastElementChild?.getBoundingClientRect();
      const patchAndLayout = performance.now() - start;
      await raf();
      if (index >= 0) {
        performance.mark(`${label}-end`);
        samples.push({ label, js, patchAndLayout });
      }
    }
    const counts = {
      cells: mount.querySelectorAll(".webhost-scene__surface-row > span")
        .length,
      rows: mount.querySelectorAll(".webhost-scene__surface-row").length,
      decorations: mount.querySelectorAll("svg").length,
      images: mount.querySelectorAll("img").length,
      semanticControls: mount.querySelectorAll("[role]").length,
      elements: mount.querySelectorAll("*").length,
    };
    const retainedIdentity =
      retained === mount.querySelector(".webhost-scene__surface-row span");
    const exact = [
      ...mount.querySelectorAll(".webhost-scene__surface-row"),
    ].every((row) =>
      [...row.children].every(
        (cell, x) => cell.textContent === (partial && x % 10 !== 0 ? "a" : "b"),
      ),
    );
    painter.dispose();
    return {
      width,
      height,
      partial,
      repeat,
      samples,
      counts,
      retainedIdentity,
      exact,
      disposedElements: mount.childElementCount,
      faces: DOM_FONT_FACES.length,
    };
  },
};
window.domPerformance = api;
declare global {
  interface Window {
    domPerformance: typeof api;
  }
}
