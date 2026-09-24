import type { GlyphGeometrySink } from "./GlyphGeometry.ts";

/** Owned primitives only: application strings never become markup. */
export class SvgGeometrySink implements GlyphGeometrySink {
  lineWidth = 1;
  lineCap = "butt";
  color = "currentColor";
  private shapes: string[] = [];
  private path = "";
  private dash: number[] = [];

  fillRect(x: number, y: number, width: number, height: number) {
    this.shapes.push(
      `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${escapeAttribute(safeColor(this.color))}"/>`,
    );
  }
  beginPath() {
    this.path = "";
  }
  moveTo(x: number, y: number) {
    this.path += `M${x} ${y}`;
  }
  lineTo(x: number, y: number) {
    this.path += `L${x} ${y}`;
  }
  bezierCurveTo(
    a: number,
    b: number,
    c: number,
    d: number,
    x: number,
    y: number,
  ) {
    this.path += `C${a} ${b} ${c} ${d} ${x} ${y}`;
  }
  setLineDash(value: number[]) {
    this.dash = value;
  }
  stroke() {
    this.shapes.push(
      `<path d="${this.path}" fill="none" stroke="${escapeAttribute(safeColor(this.color))}" stroke-width="${this.lineWidth}" stroke-linecap="${escapeAttribute(this.lineCap)}" stroke-dasharray="${this.dash.join(" ")}"/>`,
    );
  }
  image(width: number, height: number): string {
    return `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${this.shapes.join("")}</svg>`)}")`;
  }
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");
}

// The wire carries colors, never SVG paint servers or CSS resource URLs.
function safeColor(value: string): string {
  return /^(?:#[0-9a-f]{3,4}|#[0-9a-f]{6}|#[0-9a-f]{8}|[a-z]+|rgba?\([0-9.,% /+-]+\)|hsla?\([0-9.,% /+-]+\))$/i.test(
    value,
  )
    ? value
    : "none";
}
