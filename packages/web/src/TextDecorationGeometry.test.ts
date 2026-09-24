import { expect, test } from "bun:test";
import { DomGlyphBackground } from "./DomGlyphBackground.ts";
import { emitGlyphGeometry, type GlyphGeometrySink } from "./GlyphGeometry.ts";
import { emitTextDecoration } from "./TextDecorationGeometry.ts";

function mask(width: number) {
  const pixels = new Set<string>();
  const sink: GlyphGeometrySink = {
    lineWidth: 1,
    lineCap: "butt",
    beginPath() {},
    moveTo() {},
    lineTo() {},
    bezierCurveTo() {},
    setLineDash() {},
    stroke() {},
    fillRect(x, y, w, h) {
      for (let column = Math.ceil(x); column < x + w; column++)
        for (let row = Math.ceil(y); row < y + h; row++)
          if (column >= 0 && column < width) pixels.add(`${column},${row}`);
    },
  };
  return { pixels, sink };
}

test("dash-dot and dash-dot-dot preserve phase across independently emitted cells", () => {
  for (const pattern of [
    "dot",
    "dash",
    "dashDot",
    "dashDotDot",
    "double",
  ] as const) {
    const whole = mask(40),
      cells = mask(40);
    emitTextDecoration(whole.sink, pattern, 0, 10.5, 40);
    for (let x = 0; x < 40; x += 10)
      emitTextDecoration(cells.sink, pattern, x, 10.5, 10);
    expect(cells.pixels).toEqual(whole.pixels);
  }
  const shape = mask(14);
  emitTextDecoration(shape.sink, "dashDotDot", 0, 0.5, 14);
  expect([...shape.pixels]).toEqual([
    "0,0",
    "1,0",
    "2,0",
    "3,0",
    "7,0",
    "11,0",
  ]);
});

test("adjacent blocks share exact edges at every admitted device scale", () => {
  for (const scale of [1, 1.25, 1.5, 2, 3]) {
    const result = mask(20 * scale);
    for (let x = 0; x < 20; x += 10)
      emitGlyphGeometry(result.sink, "█", {
        x: x * scale,
        y: 0,
        width: 10 * scale,
        height: 24 * scale,
      });
    expect(result.pixels.size).toBe(20 * scale * 24 * scale);
  }
});

test("independent colored decoration layers keep text visible and escape SVG attributes", () => {
  const backgrounds = new DomGlyphBackground();
  const image = backgrounds.image("", "#fff", 10, 24, {
    underline: { pattern: "curly", color: "#ff0000" },
    strikethrough: { pattern: "double", color: "#00ff00" },
  })!;
  const svg = decodeURIComponent(image);
  expect(svg).toContain('stroke="#ff0000"');
  expect(svg).toContain('fill="#00ff00"');
  expect(svg).toContain('y="10.5"');
  expect(svg).toContain('y="12.5"');
  const malicious = decodeURIComponent(
    backgrounds.image("█", '"><script>', 10, 24)!,
  );
  expect(malicious).not.toContain("<script>");
  expect(malicious).toContain('fill="none"');
  expect(
    decodeURIComponent(
      backgrounds.image("█", "url(https://example.com/paint.svg)", 10, 24)!,
    ),
  ).not.toContain("https:");
  for (let i = 0; i < 600; i++) backgrounds.image("█", `rgb(${i} 0 0)`, 10, 24);
  expect(backgrounds.size).toBe(512);
});
