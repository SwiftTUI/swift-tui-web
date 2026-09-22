import {
  CanvasSurfacePainter,
  fontForStyle,
} from "../src/CanvasSurfacePainter.ts";
import type {
  WebHostSurfaceDamage,
  WebHostSurfaceFrame,
  WebHostSurfaceImage,
} from "../src/WebHostSurfaceTransport.ts";
import { normalizeWebHostTerminalStyle } from "../src/WebHostTerminalStyle.ts";

export interface CanvasDamageResult {
  incremental: number[];
  full: number[];
  unchangedBefore: number[];
  unchangedAfter: number[];
}

declare global {
  interface Window {
    runCanvasDamageAudit(overlapping: boolean): Promise<CanvasDamageResult>;
    runCanvasGlyphDamageAudit(
      previous: string,
      next: string,
    ): {
      incremental: number[];
      full: number[];
      outsideSpanInk: number;
    };
    runCanvasClipQualification(): {
      clippedMs: number;
      unclippedMs: number;
      clips: number;
      pixelDifferences: number;
    };
  }
}

// Qualification-only counterfactual: disable the per-cell save/clip/restore
// calls on a full, image-free paint. Production clipping is unchanged.
window.runCanvasClipQualification = () => {
  const canvas = document.createElement("canvas");
  const style = normalizeWebHostTerminalStyle({
    fontSize: 20,
    fontFamily: "monospace",
  });
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.font = fontForStyle(style);
  const glyphAscent = context.measureText("W").actualBoundingBoxAscent;
  // The counterfactual needs real overhang. Fixed 10x24 cells happened to
  // clip macOS's fallback font but fit Ubuntu's. A cell shorter than half
  // the measured ascent forces ink above its row on every tested engine.
  const cellHeight = Math.max(1, Math.floor(glyphAscent / 2));
  const metrics = { columns: 160, rows: 60, cellWidth: 10, cellHeight, style };
  canvas.width = 1600 * window.devicePixelRatio;
  canvas.height = 60 * cellHeight * window.devicePixelRatio;
  const frame: WebHostSurfaceFrame = {
    version: 2,
    width: 160,
    height: 60,
    styles: [null],
    rows: Array.from({ length: 60 }, () =>
      Array.from({ length: 160 }, (_, x) => [x, "W", 1, 0]),
    ),
  };
  const painter = new CanvasSurfacePainter();
  painter.attach(canvas, () => {});
  const save = context.save.bind(context),
    restore = context.restore.bind(context),
    clip = context.clip.bind(context);
  let enabled = true,
    clips = 0;
  context.save = () => {
    if (enabled) save();
  };
  context.restore = () => {
    if (enabled) restore();
  };
  context.clip = () => {
    clips++;
    if (enabled) clip();
  };
  function measure(clipped: boolean) {
    enabled = clipped;
    const samples: number[] = [];
    for (let index = 0; index < 25; index++) {
      clips = 0;
      const start = performance.now();
      painter.paint(metrics, frame);
      context.getImageData(0, 0, 1, 1); // include completion of the paint
      if (index >= 5) samples.push(performance.now() - start);
    }
    return samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)];
  }
  try {
    const clippedMs = measure(true);
    const clipped = context.getImageData(
      0,
      0,
      canvas.width,
      canvas.height,
    ).data;
    const unclippedMs = measure(false);
    const unclipped = context.getImageData(
      0,
      0,
      canvas.width,
      canvas.height,
    ).data;
    let pixelDifferences = 0;
    for (let index = 0; index < clipped.length; index += 4) {
      if (
        clipped[index] !== unclipped[index] ||
        clipped[index + 1] !== unclipped[index + 1] ||
        clipped[index + 2] !== unclipped[index + 2] ||
        clipped[index + 3] !== unclipped[index + 3]
      )
        pixelDifferences++;
    }
    return { clippedMs, unclippedMs, clips, pixelDifferences };
  } finally {
    context.save = save;
    context.restore = restore;
    context.clip = clip;
    painter.dispose();
  }
};

window.runCanvasDamageAudit = async (overlapping) => {
  const scale = window.devicePixelRatio;
  const metrics = {
    columns: 8,
    rows: 4,
    cellWidth: 1,
    cellHeight: 1,
    style: normalizeWebHostTerminalStyle({ theme: { background: "#000000" } }),
  };
  const images: WebHostSurfaceImage[] = [
    {
      id: "white",
      format: "png",
      bounds: [1, 1, 5, 2],
      visibleBounds: [1, 1, 5, 2],
      scalingMode: "stretch",
      opacity: 0.5,
      dataBase64: "QQ==",
    },
  ];
  if (overlapping) {
    images.push({
      id: "red",
      format: "png",
      bounds: [2, 1, 4, 2],
      visibleBounds: [3, 1, 2, 2],
      scalingMode: "stretch",
      opacity: 0.5,
      dataBase64: "QQ==",
    });
  }
  const initial: WebHostSurfaceFrame = {
    version: 2,
    width: 8,
    height: 4,
    styles: [null, { bg: "#0000ff" }],
    rows: [[], [], [], []],
    images,
  };
  const next: WebHostSurfaceFrame = {
    ...initial,
    rows: [
      [],
      [
        [1, " ", 1, 1],
        [5, " ", 1, 1],
      ],
      [[3, " ", 1, 1]],
      [],
    ],
  };
  const damage: WebHostSurfaceDamage = {
    textRows: [
      [
        1,
        [
          [1, 2],
          [5, 6],
        ],
      ],
      [2, [[3, 4]]],
    ],
    requiresFullTextRepaint: false,
    requiresFullGraphicsReplay: false,
  };

  async function preparedPainter() {
    const canvas = document.createElement("canvas");
    canvas.width = 8 * scale;
    canvas.height = 4 * scale;
    document.body.append(canvas);
    let completed = 0;
    let ready!: () => void;
    const decoded = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const painter = new CanvasSurfacePainter({
      decodeImage: async (_payload, _format, id) =>
        createImageBitmap(
          new ImageData(
            new Uint8ClampedArray(
              id === "red" ? [255, 0, 0, 255] : [255, 255, 255, 255],
            ),
            1,
            1,
          ),
        ),
    });
    painter.attach(canvas, () => {
      if (++completed === images.length) ready();
    });
    painter.paint(metrics, initial);
    await decoded;
    painter.paint(metrics, initial);
    const context = canvas.getContext("2d")!;
    return { painter, canvas, context };
  }
  const actual = await preparedPainter();
  const reference = await preparedPainter();
  try {
    const unchangedBefore = Array.from(
      actual.context.getImageData(3 * scale, scale, 1, 1).data,
    );
    for (let repeat = 0; repeat < 3; repeat++)
      actual.painter.paint(metrics, next, damage);
    reference.painter.paint(metrics, next);
    return {
      incremental: Array.from(
        actual.context.getImageData(
          0,
          0,
          actual.canvas.width,
          actual.canvas.height,
        ).data,
      ),
      full: Array.from(
        reference.context.getImageData(
          0,
          0,
          reference.canvas.width,
          reference.canvas.height,
        ).data,
      ),
      unchangedBefore,
      unchangedAfter: Array.from(
        actual.context.getImageData(3 * scale, scale, 1, 1).data,
      ),
    };
  } finally {
    actual.painter.dispose();
    reference.painter.dispose();
    actual.canvas.remove();
    reference.canvas.remove();
  }
};

window.runCanvasGlyphDamageAudit = (previous, next) => {
  const scale = window.devicePixelRatio;
  const style = normalizeWebHostTerminalStyle({
    fontSize: 20,
    fontFamily: "monospace",
    theme: { background: "#000000", foreground: "#ffffff" },
  });
  const measure = document.createElement("canvas").getContext("2d")!;
  measure.font = fontForStyle(style);
  const cellWidth = Math.ceil(measure.measureText("W").width);
  const cellHeight = 27;
  const metrics = { columns: 4, rows: 1, cellWidth, cellHeight, style };
  const frame = (text: string): WebHostSurfaceFrame => ({
    version: 2,
    width: 4,
    height: 1,
    styles: [{ em: 2 }],
    rows: [[[1, text, 1, 0]]],
  });
  const damage: WebHostSurfaceDamage = {
    textRows: [[0, [[1, 2]]]],
    requiresFullTextRepaint: false,
    requiresFullGraphicsReplay: false,
  };
  function preparedPainter(text: string) {
    const canvas = document.createElement("canvas");
    canvas.width = 4 * cellWidth * scale;
    canvas.height = cellHeight * scale;
    const painter = new CanvasSurfacePainter();
    painter.attach(canvas, () => {});
    painter.paint(metrics, frame(text));
    return { canvas, painter, context: canvas.getContext("2d")! };
  }
  const actual = preparedPainter(previous);
  const reference = preparedPainter(next);
  try {
    actual.painter.paint(metrics, frame(next), damage);
    const pixels = reference.context.getImageData(
      0,
      0,
      reference.canvas.width,
      reference.canvas.height,
    ).data;
    let outsideSpanInk = 0;
    for (let y = 0; y < reference.canvas.height; y++) {
      for (let x = 0; x < reference.canvas.width; x++) {
        if (x >= cellWidth * scale && x < 2 * cellWidth * scale) continue;
        const offset = (y * reference.canvas.width + x) * 4;
        if (pixels[offset] || pixels[offset + 1] || pixels[offset + 2])
          outsideSpanInk++;
      }
    }
    return {
      incremental: Array.from(
        actual.context.getImageData(
          0,
          0,
          actual.canvas.width,
          actual.canvas.height,
        ).data,
      ),
      full: Array.from(pixels),
      outsideSpanInk,
    };
  } finally {
    actual.painter.dispose();
    reference.painter.dispose();
  }
};
