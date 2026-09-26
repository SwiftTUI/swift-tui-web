import type { SurfaceMetrics } from "./SurfaceRenderer.ts";
import { fontForStyle } from "./SurfaceTypography.ts";
import type {
  WebHostSurfaceCell,
  WebHostSurfaceFrame,
} from "./WebHostSurfaceTransport.ts";

/** ASCII may flow within an allocated run; fallback clusters keep independent origins. */
export function naturalText(text: string, span: number): boolean {
  return /^[\x20-\x7e]+$/.test(text) && text.length === span;
}

/** Batched DOM shaping measurements. No Canvas or searchable duplicate text. */
export class DomTextLayout {
  private readonly probe: HTMLElement;
  private readonly ruler: HTMLElement;
  private config = "";
  private advances = new Map<string, number>();
  private base = [0, 0, 0, 0];
  private monospace = [false, false, false, false];

  get cacheEntries(): number {
    return this.advances.size;
  }
  clear(): void {
    this.advances.clear();
  }

  constructor(mount: HTMLElement) {
    this.probe = document.createElement("div");
    this.probe.setAttribute("aria-hidden", "true");
    Object.assign(this.probe.style, {
      position: "absolute",
      visibility: "hidden",
      pointerEvents: "none",
      userSelect: "none",
      left: "0",
      top: "0",
      width: "max-content",
      height: "auto",
      margin: "0",
      padding: "0",
      border: "0",
      overflow: "hidden",
      contain: "layout style",
      float: "none",
      minWidth: "0",
      maxWidth: "none",
      minHeight: "0",
      maxHeight: "none",
    });
    this.ruler = document.createElement("div");
    Object.assign(this.ruler.style, {
      display: "block",
      width: "1024px",
      height: "0",
      margin: "0",
      padding: "0",
      border: "0",
      boxSizing: "border-box",
      float: "none",
      minWidth: "0",
      maxWidth: "none",
    });
    this.probe.appendChild(this.ruler);
    mount.appendChild(this.probe);
  }

  invalidate(): void {
    this.config = "";
  }
  dispose(): void {
    this.probe.remove();
    this.advances.clear();
  }

  private sample(
    text: string,
    em: number,
    metrics: SurfaceMetrics,
    spacing: number,
  ): HTMLElement {
    const line = document.createElement("div");
    Object.assign(line.style, {
      display: "block",
      width: "max-content",
      height: "auto",
      margin: "0",
      padding: "0",
      border: "0",
      float: "none",
      minWidth: "0",
      maxWidth: "none",
      minHeight: "0",
      maxHeight: "none",
      whiteSpace: "pre",
      textIndent: "0",
      textTransform: "none",
      textAlign: "left",
      font: fontForStyle(metrics.style, { em }),
      lineHeight: "1.5",
    });
    const span = document.createElement("span");
    Object.assign(span.style, {
      display: "inline",
      font: "inherit",
      lineHeight: "inherit",
      whiteSpace: "pre",
      margin: "0",
      padding: "0",
      border: "0",
      float: "none",
      textTransform: "none",
      fontKerning: "none",
      fontVariantLigatures: "none",
      fontSynthesis: "none",
      letterSpacing: `${spacing}px`,
      wordSpacing: "0",
      direction: "ltr",
      unicodeBidi: "isolate",
    });
    span.textContent = text;
    line.appendChild(span);
    this.probe.appendChild(line);
    return span;
  }

  spacing(text: string, span: number, em: number, width: number): number {
    return this.monospace[em & 3] && naturalText(text, span)
      ? width - this.base[em & 3]!
      : 0;
  }

  private key(text: string, span: number, em: number): string {
    return JSON.stringify([
      em & 3,
      this.monospace[em & 3] && naturalText(text, span) ? text.length : text,
    ]);
  }

  advance(text: string, span: number, em: number): number {
    return this.advances.get(this.key(text, span, em)) ?? 0;
  }

  prepare(
    frame: WebHostSurfaceFrame,
    metrics: SurfaceMetrics,
    linkedRows: Set<number>,
  ): WebHostSurfaceCell[][] {
    // A local ruler accounts for ancestor transforms, CSS zoom and browser zoom.
    // Read before patches; font/configuration changes are the only two-stage measurement.
    const scale = this.ruler.getBoundingClientRect().width / 1024 || 1;
    const config = JSON.stringify([
      fontForStyle(metrics.style),
      metrics.cellWidth,
      scale,
    ]);
    if (config !== this.config) {
      this.advances.clear();
      const samples = [0, 1, 2, 3].map((em) => [
        this.sample("W".repeat(64), em, metrics, 0),
        this.sample("i".repeat(64), em, metrics, 0),
      ]);
      samples.forEach(([wide, narrow], em) => {
        this.base[em] = wide!.getBoundingClientRect().width / scale / 64;
        this.monospace[em] =
          Math.abs(
            this.base[em]! - narrow!.getBoundingClientRect().width / scale / 64,
          ) < 0.001;
      });
      this.probe.replaceChildren(this.ruler);
      this.config = config;
    }
    const rows = frame.rows.map((cells, y) => {
      const spaced: WebHostSurfaceCell[] = [];
      let end = 0;
      for (const cell of cells) {
        if (cell[0] > end)
          spaced.push([end, " ".repeat(cell[0] - end), cell[0] - end, -1]);
        spaced.push(cell);
        end = cell[0] + Math.max(1, cell[2]);
      }
      if (end < frame.width)
        spaced.push([
          end,
          " ".repeat(frame.width - end),
          frame.width - end,
          -1,
        ]);
      const result: WebHostSurfaceCell[] = [];
      for (const cell of spaced) {
        const last = result.at(-1);
        if (
          !linkedRows.has(y) &&
          this.monospace[(frame.styles[cell[3]]?.em ?? 0) & 3] &&
          last &&
          last[3] === cell[3] &&
          last[0] + last[2] === cell[0] &&
          naturalText(last[1], last[2]) &&
          naturalText(cell[1], cell[2])
        ) {
          last[1] += cell[1];
          last[2] += cell[2];
        } else result.push([...cell]);
      }
      return result;
    });
    const used = new Set<string>();
    const missing = new Map<string, HTMLElement>();
    for (const row of rows)
      for (const [, text, span, index] of row) {
        const em = frame.styles[index]?.em ?? 0,
          key = this.key(text, span, em);
        used.add(key);
        if (!this.advances.has(key) && !missing.has(key))
          missing.set(
            key,
            this.sample(
              text,
              em,
              metrics,
              this.spacing(text, span, em, metrics.cellWidth),
            ),
          );
      }
    for (const [key, element] of missing)
      this.advances.set(key, element.getBoundingClientRect().width / scale);
    if (missing.size) this.probe.replaceChildren(this.ruler);
    // Ownership is bounded by the current frame, never text encountered over time.
    for (const key of this.advances.keys())
      if (!used.has(key)) this.advances.delete(key);
    return rows;
  }
}
