import { fontForStyle } from "./SurfaceTypography.ts";
import type { ResolvedWebHostTerminalStyle } from "./WebHostTerminalStyle.ts";

export interface DomCellMeasurement {
  width: number;
  height: number;
  advance: number;
  baseline: number;
  fontSize: number;
}

/** Persistent, inert typography sentinel. Never participates in selection or find. */
export class DomCellProbe {
  readonly element: HTMLElement;
  private readonly faces: {
    line: HTMLElement;
    text: HTMLElement;
    baseline: HTMLElement;
  }[];
  private styleKey?: string;

  constructor(private readonly mount: HTMLElement) {
    const doc = mount.ownerDocument ?? document;
    this.element = doc.createElement("div");
    this.element.setAttribute("aria-hidden", "true");
    Object.assign(this.element.style, {
      position: "absolute",
      visibility: "hidden",
      pointerEvents: "none",
      userSelect: "none",
      width: "max-content",
      height: "auto",
      left: "0",
      top: "0",
      overflow: "hidden",
      contain: "layout style",
      margin: "0",
      padding: "0",
      border: "0",
    });
    this.faces = [0, 1, 2, 3].map(() => {
      const line = doc.createElement("div");
      const text = doc.createElement("span");
      const baseline = doc.createElement("span");
      Object.assign(baseline.style, {
        display: "inline-block",
        width: "0",
        height: "0",
        padding: "0",
        margin: "0",
        border: "0",
        verticalAlign: "baseline",
      });
      line.append(text, baseline);
      this.element.appendChild(line);
      return { line, text, baseline };
    });
    mount.appendChild(this.element);
  }

  configure(style: ResolvedWebHostTerminalStyle): void {
    const key = fontForStyle(style);
    if (key === this.styleKey) return;
    this.styleKey = key;
    this.faces.forEach(({ line, text }, em) => {
      Object.assign(line.style, {
        display: "block",
        width: "max-content",
        height: "auto",
        padding: "0",
        margin: "0",
        border: "0",
        font: fontForStyle(style, { em }),
        lineHeight: "1.5",
        whiteSpace: "pre",
      });
      Object.assign(text.style, {
        display: "inline",
        font: "inherit",
        // Unitless so a browser minimum size or user text-size override on
        // the glyph also enlarges its measured line box.
        lineHeight: "1.5",
        padding: "0",
        margin: "0",
        border: "0",
        fontVariantLigatures: "none",
        fontKerning: "none",
        fontSynthesis: "none",
        letterSpacing: "0px",
        wordSpacing: "0px",
        whiteSpace: "pre",
        direction: "ltr",
        unicodeBidi: "isolate",
      });
      text.textContent = "W".repeat(64);
    });
  }

  measure(
    style: ResolvedWebHostTerminalStyle,
    scaleX = 1,
    scaleY = scaleX,
  ): DomCellMeasurement | undefined {
    this.configure(style);
    let width = 0,
      height = 0,
      baseline = 0;
    for (const face of this.faces) {
      const rect = face.text.getBoundingClientRect();
      const line = face.line.getBoundingClientRect();
      if (!(rect.width > 0 && line.height > 0)) return undefined;
      width = Math.max(width, rect.width / scaleX / 64);
      height = Math.max(height, line.height / scaleY);
      baseline = Math.max(
        baseline,
        (face.baseline.getBoundingClientRect().top - line.top) / scaleY,
      );
    }
    // Probe the same CSS and line boxes for clusters/fallbacks; never infer
    // their allocation from UTF-16 length or scale glyph artwork to a cell.
    const baseAdvance = width;
    const face = this.faces[0]!;
    for (const [sample, span] of [
      [" ", 1],
      ["e\u0301", 1],
      ["漢", 2],
      ["🙂", 2],
      ["👩‍💻", 2],
    ] as const) {
      face.text.textContent = sample;
      const rect = face.text.getBoundingClientRect();
      width = Math.max(width, rect.width / scaleX / span);
      height = Math.max(
        height,
        face.line.getBoundingClientRect().height / scaleY,
      );
    }
    face.text.textContent = "W".repeat(64);
    if (
      ![width, height, baseline].every(Number.isFinite) ||
      width <= 0 ||
      height <= 0
    )
      return undefined;
    const computed = this.mount.ownerDocument?.defaultView?.getComputedStyle(
      face.text,
    );
    // CSS engines quantize transformed line boxes. Ignore at most 1/32 CSS px
    // of measurement noise at an integral boundary, never a whole pixel.
    return {
      width: Math.ceil(width - 1 / 32),
      height: Math.ceil(height - 1 / 32),
      advance: baseAdvance,
      baseline,
      fontSize: Number.parseFloat(computed?.fontSize ?? "") || style.fontSize,
    };
  }

  dispose(): void {
    this.element.remove();
  }
}

/** One-shot convenience for custom hosts; the runtime owns a persistent probe. */
export function measureDomCells(
  mount: HTMLElement,
  style: ResolvedWebHostTerminalStyle,
): DomCellMeasurement | undefined {
  const probe = new DomCellProbe(mount);
  try {
    return probe.measure(style);
  } finally {
    probe.dispose();
  }
}
