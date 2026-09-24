import { canRenderGeometricGlyph, emitGlyphGeometry } from "./GlyphGeometry.ts";
import { SvgGeometrySink } from "./SvgGeometrySink.ts";
import { emitTextDecoration } from "./TextDecorationGeometry.ts";
import type { WebHostSurfaceStyle } from "./WebHostSurfaceTransport.ts";

/** Per-painter, bounded SVG cache over renderer-neutral primitives. */
export class DomGlyphBackground {
  private readonly cache = new Map<string, string>();
  get size(): number {
    return this.cache.size;
  }
  clear(): void {
    this.cache.clear();
  }

  image(
    text: string,
    color: string,
    width: number,
    height: number,
    style?: WebHostSurfaceStyle,
    phaseX = 0,
  ): string | undefined {
    const geometric = canRenderGeometricGlyph(text);
    if (!geometric && !style?.underline && !style?.strikethrough)
      return undefined;
    const key = JSON.stringify([
      text,
      color,
      width,
      height,
      style?.underline,
      style?.strikethrough,
      phaseX,
    ]);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const sink = new SvgGeometrySink();
    sink.color = color;
    if (geometric) emitGlyphGeometry(sink, text, { x: 0, y: 0, width, height });
    for (const [line, y] of [
      [style?.underline, height - 2],
      [style?.strikethrough, Math.floor(height / 2)],
    ] as const) {
      if (!line) continue;
      sink.color = line.color ?? color;
      emitTextDecoration(sink, line.pattern, 0, y, width, phaseX);
    }
    const result = sink.image(width, height);
    if (this.cache.size >= 512)
      this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(key, result);
    return result;
  }
}
