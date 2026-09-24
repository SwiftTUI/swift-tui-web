import type { GlyphGeometrySink } from "./GlyphGeometry.ts";
import type { WebHostSurfaceLineStyle } from "./WebHostSurfaceTransport.ts";

/** One CSS-pixel stroke, with phase anchored to the surface's left edge.
 * Callers clip to the cell allocation. Both backends consume this geometry. */
export function emitTextDecoration(
  sink: GlyphGeometrySink,
  pattern: WebHostSurfaceLineStyle["pattern"],
  x: number,
  y: number,
  width: number,
  phaseX = x,
): void {
  if (pattern === "double") {
    sink.fillRect(x, y - 1.5, width, 1);
    sink.fillRect(x, y + 0.5, width, 1);
    return;
  }
  if (pattern === "curly") {
    const period = 6;
    const start = x - positiveRemainder(phaseX, period);
    sink.lineWidth = 1;
    sink.lineCap = "butt";
    sink.setLineDash([]);
    sink.beginPath();
    sink.moveTo(start, y);
    for (let p = start; p < x + width; p += period) {
      sink.bezierCurveTo(p + 1, y - 2, p + 2, y - 2, p + 3, y);
      sink.bezierCurveTo(p + 4, y + 2, p + 5, y + 2, p + 6, y);
    }
    sink.stroke();
    return;
  }
  const patternLengths = {
    solid: [width],
    dot: [1, 3],
    dash: [4, 3],
    dashDot: [4, 3, 1, 3],
    dashDotDot: [4, 3, 1, 3, 1, 3],
  }[pattern] ?? [width];
  if (pattern === "solid") {
    sink.fillRect(x, y - 0.5, width, 1);
    return;
  }
  const period = patternLengths.reduce((sum, value) => sum + value, 0);
  let p = x - positiveRemainder(phaseX, period);
  while (p < x + width) {
    for (const [index, length] of patternLengths.entries()) {
      const left = Math.max(x, p),
        right = Math.min(x + width, p + length);
      if (index % 2 === 0 && right > left)
        sink.fillRect(left, y - 0.5, right - left, 1);
      p += length;
    }
  }
}

function positiveRemainder(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}
