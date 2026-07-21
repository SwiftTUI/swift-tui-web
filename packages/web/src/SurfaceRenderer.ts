import type { ResolvedWebHostTerminalStyle } from "./WebHostTerminalStyle.ts";
import type {
  WebHostSurfaceDamage,
  WebHostSurfaceFrame,
  WebHostSurfaceStyle,
} from "./WebHostSurfaceTransport.ts";

/**
 * Which presenter draws surface frames into the scene mount.
 *
 * - `"canvas"` (default): paints cells onto a 2D `<canvas>` — pixel-exact
 *   box-drawing seams and decoration patterns, one DOM node total.
 * - `"dom"`: renders cells as absolutely positioned text elements — native
 *   font rendering (fallback glyphs, subpixel AA, crisp zoom), an
 *   inspectable element tree, and real selectable text (hold Alt/Option and
 *   drag). Box drawing and decoration patterns render via font glyphs and
 *   CSS `text-decoration`, so hairline seams may differ from the canvas
 *   painter.
 */
export type WebHostSurfaceRendererKind = "canvas" | "dom";

/**
 * A read-only snapshot of the cell grid geometry and active style a surface
 * painter needs for a single paint pass. The runtime owns this state and
 * mutates it as the surface resizes or restyles; passing a fresh snapshot per
 * `paint` keeps painters stateless about geometry and avoids stale reads.
 */
export interface SurfaceMetrics {
  columns: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  style: ResolvedWebHostTerminalStyle;
}

/**
 * The paint seam shared by the canvas and DOM painters. The runtime calls
 * `paint` with the latest metrics snapshot, the current frame (or `undefined`
 * before the first frame), and optional damage scoping the repaint.
 */
export interface WebHostSurfacePainter {
  paint(
    metrics: SurfaceMetrics,
    frame: WebHostSurfaceFrame | undefined,
    damage?: WebHostSurfaceDamage
  ): void;
}

/**
 * The effective text color for a cell, folding the reverse-video emphasis bit
 * (`em & 16`) over the host terminal theme's defaults.
 */
export function resolvedSurfaceForeground(
  style: WebHostSurfaceStyle | null | undefined,
  terminalStyle: ResolvedWebHostTerminalStyle
): string {
  if ((style?.em ?? 0) & 16) {
    return style?.bg ?? terminalStyle.theme.background;
  }
  return style?.fg ?? terminalStyle.theme.foreground;
}

/**
 * The effective background fill for a cell (or `undefined` for the terminal's
 * base background), folding the reverse-video emphasis bit (`em & 16`).
 */
export function resolvedSurfaceBackground(
  style: WebHostSurfaceStyle | null | undefined,
  terminalStyle: ResolvedWebHostTerminalStyle
): string | undefined {
  if ((style?.em ?? 0) & 16) {
    return style?.fg ?? terminalStyle.theme.foreground;
  }
  return style?.bg;
}
