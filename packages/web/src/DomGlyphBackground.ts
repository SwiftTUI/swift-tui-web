import { canRenderBoxDrawing, drawBoxDrawing } from "./BoxDrawingRenderer.ts";

/** Per-painter, bounded SVG cache. Geometry is shared with the Canvas painter. */
export class DomGlyphBackground {
  private readonly cache = new Map<string, string>();

  clear(): void {
    this.cache.clear();
  }

  image(
    text: string,
    color: string,
    width: number,
    height: number,
  ): string | undefined {
    if (!canRenderBoxDrawing(text)) return undefined;
    const key = JSON.stringify([text, color, width, height]);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const shapes: string[] = [];
    let path = "";
    let dash: number[] = [];
    const context = {
      lineWidth: 1,
      lineCap: "butt",
      fillRect(x: number, y: number, w: number, h: number) {
        shapes.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}"/>`);
      },
      beginPath() {
        path = "";
      },
      moveTo(x: number, y: number) {
        path += `M${x} ${y}`;
      },
      lineTo(x: number, y: number) {
        path += `L${x} ${y}`;
      },
      bezierCurveTo(
        a: number,
        b: number,
        c: number,
        d: number,
        x: number,
        y: number,
      ) {
        path += `C${a} ${b} ${c} ${d} ${x} ${y}`;
      },
      setLineDash(value: number[]) {
        dash = value;
      },
      stroke() {
        shapes.push(
          `<path d="${path}" fill="none" stroke="currentColor" stroke-width="${this.lineWidth}" stroke-linecap="${this.lineCap}" stroke-dasharray="${dash.join(" ")}"/>`,
        );
      },
    };
    if (!drawBoxDrawing(context, text, { x: 0, y: 0, width, height }))
      return undefined;
    const escapedColor = color
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" color="${escapedColor}" fill="currentColor">${shapes.join("")}</svg>`;
    const result = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
    if (this.cache.size >= 512)
      this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(key, result);
    return result;
  }
}
