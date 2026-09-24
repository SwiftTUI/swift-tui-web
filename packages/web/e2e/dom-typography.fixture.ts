import {
  DomSurfacePainter,
  normalizeWebHostTerminalStyle,
  type WebHostSurfaceCell,
} from "../dist/index.js";

const mount = document.createElement("div");
mount.id = "typography";
document.body.replaceChildren(mount);
const painter = new DomSurfacePainter();
painter.attach(mount);
const samples: WebHostSurfaceCell[] = [
  [0, "A", 1, 0],
  [1, " ", 1, 0],
  [2, "e\u0301", 1, 0],
  [3, "漢", 2, 0],
  [5, "🙂", 2, 0],
  [7, "👩‍💻", 2, 0],
  [9, "✈️", 2, 0],
  [11, "א", 1, 0],
  [12, "ב", 1, 0],
  [13, "ع", 1, 0],
  [14, "ر", 1, 0],
  [15, "क्‍ष", 2, 0],
  [17, "", 1, 0],
  [18, "_", 1, 0],
  [19, "j", 1, 0],
];
const api = {
  samples,
  paint(size: number, replacement = false) {
    // Independent integral allocation for this painter-only corpus. Runtime
    // metric-probe qualification is separate from this explicit wire-box test.
    const cw = Math.ceil(size * 0.6),
      ch = Math.ceil(size * 1.5);
    mount.style.cssText = `width:${cw * 201}px;height:${ch * 5}px`;
    const row = samples.map((cell) => [...cell] as WebHostSurfaceCell);
    if (replacement) row.splice(3, 1, [3, "n", 1, 0]);
    painter.paint(
      {
        columns: 201,
        rows: 5,
        cellWidth: cw,
        cellHeight: ch,
        style: normalizeWebHostTerminalStyle({
          fontSize: size,
          fontFamily:
            '"SwiftTUI Qualification", "PingFang SC", "Hiragino Sans", "Noto Sans CJK SC", "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", monospace',
          theme: { foreground: "#111", background: "#fff" },
        }),
      },
      {
        version: 2,
        width: 201,
        height: 5,
        styles: [null, { em: 1 }, { em: 2 }, { em: 3 }],
        rows: [
          row,
          row.map(([x, text, span]) => [x, text, span, 1]),
          row.map(([x, text, span]) => [x, text, span, 2]),
          row.map(([x, text, span]) => [x, text, span, 3]),
          Array.from({ length: 201 }, (_, x) => [x, "W", 1, 0]),
        ],
      },
    );
    return { cw, ch };
  },
  dispose() {
    painter.dispose();
  },
};
window.typography = api;
declare global {
  interface Window {
    typography: typeof api;
  }
}
