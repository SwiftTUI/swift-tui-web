import type { WebHostSurfaceStyle } from "./WebHostSurfaceTransport.ts";
import type { ResolvedWebHostTerminalStyle } from "./WebHostTerminalStyle.ts";

/**
 * The CSS font string for a cell, folding the surface emphasis bits (bold,
 * italic) over the host terminal's font size/family. Exposed so the host can
 * reuse the exact same metric when measuring cell dimensions.
 */
export function fontForStyle(
  terminalStyle: ResolvedWebHostTerminalStyle,
  style?: WebHostSurfaceStyle | null,
): string {
  const emphasis = style?.em ?? 0;
  const italic = (emphasis & 2) !== 0 ? "italic " : "";
  const weight = (emphasis & 1) !== 0 ? "700 " : "";
  return `${italic}${weight}${terminalStyle.fontSize}px ${terminalStyle.fontFamily}`;
}
