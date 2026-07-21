import {
  canRenderBoxDrawing,
  drawBoxDrawing,
} from "./BoxDrawingRenderer.ts";
import {
  resolvedSurfaceBackground,
  resolvedSurfaceForeground,
  type SurfaceMetrics,
  type WebHostSurfacePainter,
} from "./SurfaceRenderer.ts";
import {
  type ResolvedWebHostTerminalStyle,
  webTUITerminalBackgroundColor,
} from "./WebHostTerminalStyle.ts";
import type {
  WebHostSurfaceDamage,
  WebHostSurfaceFrame,
  WebHostSurfaceImage,
  WebHostSurfaceImageFormat,
  WebHostSurfaceStyle,
} from "./WebHostSurfaceTransport.ts";

/**
 * A read-only snapshot of the cell grid geometry and active style the painter
 * needs for a single paint pass — see {@link SurfaceMetrics}, shared with the
 * DOM painter. The alias keeps this painter's original public name stable.
 */
export type CanvasSurfaceMetrics = SurfaceMetrics;

interface CachedWebHostImage {
  image?: CanvasImageSource;
  promise?: Promise<CanvasImageSource>;
}

interface DirtyRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface DirtyCellRange {
  start: number;
  end: number;
}

type DirtyRowRanges = "full" | DirtyCellRange[];

interface DirtyRegion {
  rects: DirtyRect[];
  rows: Map<number, DirtyRowRanges>;
}

/**
 * Draws SwiftTUI surface frames onto a 2D canvas: background fills, per-cell
 * text/box-drawing/decorations, surface images, and damage-scoped dirty-region
 * painting. The painter caches decoded images and asks the host to repaint once
 * an image finishes decoding (via the `requestRedraw` callback).
 *
 * Geometry and style are supplied per paint via {@link CanvasSurfaceMetrics};
 * the painter holds only the canvas handle, the image cache, and the redraw
 * callback as durable state.
 */
export class CanvasSurfacePainter implements WebHostSurfacePainter {
  private readonly imageCache = new Map<string, CachedWebHostImage>();
  private canvas?: HTMLCanvasElement;
  private requestRedraw: () => void = () => {};

  /**
   * Binds the canvas the painter draws into and the callback used to request a
   * full repaint after an asynchronous image decode completes.
   */
  attach(
    canvas: HTMLCanvasElement,
    requestRedraw: () => void
  ): void {
    this.canvas = canvas;
    this.requestRedraw = requestRedraw;
  }

  paint(
    metrics: CanvasSurfaceMetrics,
    frame: WebHostSurfaceFrame | undefined,
    damage?: WebHostSurfaceDamage
  ): void {
    const canvas = this.canvas;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) {
      return;
    }

    const dirtyRegion = frame
      ? this.dirtyRegionForDamage(damage, frame, metrics)
      : undefined;
    if (dirtyRegion?.rects.length === 0) {
      return;
    }

    const scale = globalThis.window?.devicePixelRatio || 1;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.textBaseline = "alphabetic";

    context.fillStyle = webTUITerminalBackgroundColor(metrics.style);
    if (dirtyRegion) {
      for (const rect of dirtyRegion.rects) {
        context.clearRect(rect.x, rect.y, rect.width, rect.height);
        context.fillRect(rect.x, rect.y, rect.width, rect.height);
      }
    } else {
      context.clearRect(0, 0, canvas.width / scale, canvas.height / scale);
      context.fillRect(0, 0, metrics.columns * metrics.cellWidth, metrics.rows * metrics.cellHeight);
    }

    if (!frame) {
      return;
    }

    this.drawRows(context, frame, metrics, dirtyRegion);
    this.drawImages(context, frame.images ?? [], metrics, dirtyRegion);
  }

  private drawRows(
    context: CanvasRenderingContext2D,
    frame: WebHostSurfaceFrame,
    metrics: CanvasSurfaceMetrics,
    dirtyRegion?: DirtyRegion
  ): void {
    if (dirtyRegion) {
      for (const [y, ranges] of dirtyRegion.rows) {
        const row = frame.rows[y] ?? [];
        this.drawRow(context, frame, metrics, row, y, ranges);
      }
      return;
    }

    for (let y = 0; y < frame.rows.length; y += 1) {
      const row = frame.rows[y] ?? [];
      this.drawRow(context, frame, metrics, row, y);
    }
  }

  private drawRow(
    context: CanvasRenderingContext2D,
    frame: WebHostSurfaceFrame,
    metrics: CanvasSurfaceMetrics,
    row: WebHostSurfaceFrame["rows"][number],
    y: number,
    ranges?: DirtyRowRanges
  ): void {
    for (const cell of row) {
      const [x, text, span, styleIndex] = cell;
      if (ranges !== undefined && !cellIntersectsRanges(x, span, ranges)) {
        continue;
      }
      const style = frame.styles[styleIndex] ?? undefined;
      this.drawCell(context, metrics, x, y, text, span, style);
    }
  }

  private drawImages(
    context: CanvasRenderingContext2D,
    images: WebHostSurfaceImage[],
    metrics: CanvasSurfaceMetrics,
    dirtyRegion?: DirtyRegion
  ): void {
    for (const image of images) {
      this.drawImage(context, image, metrics, dirtyRegion);
    }
  }

  private drawImage(
    context: CanvasRenderingContext2D,
    image: WebHostSurfaceImage,
    metrics: CanvasSurfaceMetrics,
    dirtyRegion?: DirtyRegion
  ): void {
    const decodedImage = this.cachedImage(image);
    if (!decodedImage) {
      return;
    }

    const [boundsX, boundsY, boundsWidth, boundsHeight] = image.bounds;
    const [clipX, clipY, clipWidth, clipHeight] = image.visibleBounds;
    if (boundsWidth <= 0 || boundsHeight <= 0 || clipWidth <= 0 || clipHeight <= 0) {
      return;
    }
    if (
      dirtyRegion
      && !dirtyRegionIntersectsCellRect(dirtyRegion, clipX, clipY, clipWidth, clipHeight)
    ) {
      return;
    }

    context.save();
    context.beginPath();
    context.rect(
      clipX * metrics.cellWidth,
      clipY * metrics.cellHeight,
      clipWidth * metrics.cellWidth,
      clipHeight * metrics.cellHeight
    );
    context.clip();
    context.drawImage(
      decodedImage,
      boundsX * metrics.cellWidth,
      boundsY * metrics.cellHeight,
      boundsWidth * metrics.cellWidth,
      boundsHeight * metrics.cellHeight
    );
    context.restore();
  }

  private cachedImage(
    image: WebHostSurfaceImage
  ): CanvasImageSource | undefined {
    const cached = this.imageCache.get(image.id);
    if (cached?.image) {
      return cached.image;
    }

    if (!cached?.promise && image.dataBase64) {
      const promise = decodeImage(image.dataBase64, image.format);
      this.imageCache.set(image.id, { promise });
      void promise.then((decodedImage) => {
        const latest = this.imageCache.get(image.id);
        if (latest?.promise !== promise) {
          return;
        }
        this.imageCache.set(image.id, { image: decodedImage });
        this.requestRedraw();
      }).catch(() => {
        this.imageCache.delete(image.id);
      });
    }

    return undefined;
  }

  private drawCell(
    context: CanvasRenderingContext2D,
    metrics: CanvasSurfaceMetrics,
    x: number,
    y: number,
    text: string,
    span: number,
    style?: WebHostSurfaceStyle | null
  ): void {
    const rectX = x * metrics.cellWidth;
    const rectY = y * metrics.cellHeight;
    const width = Math.max(1, span) * metrics.cellWidth;
    const background = resolvedSurfaceBackground(style, metrics.style);
    const foreground = resolvedSurfaceForeground(style, metrics.style);
    const opacity = style?.opacity ?? 1;

    if (background) {
      context.globalAlpha = opacity;
      context.fillStyle = background;
      context.fillRect(rectX, rectY, width, metrics.cellHeight);
    }

    if (text !== " ") {
      context.globalAlpha = opacity;
      context.fillStyle = foreground;
      context.strokeStyle = foreground;
      if (!canRenderBoxDrawing(text) || !drawBoxDrawing(context, text, {
        x: rectX,
        y: rectY,
        width,
        height: metrics.cellHeight,
      })) {
        context.font = fontForStyle(metrics.style, style);
        context.fillText(
          text,
          rectX,
          rectY + Math.floor((metrics.cellHeight + metrics.style.fontSize) / 2) - 2
        );
      }
    }

    this.drawTextLine(context, metrics, rectX, rectY, width, style?.underline, "underline", foreground);
    this.drawTextLine(context, metrics, rectX, rectY, width, style?.strikethrough, "strike", foreground);
    context.globalAlpha = 1;
  }

  private dirtyRegionForDamage(
    damage: WebHostSurfaceDamage | undefined,
    frame: WebHostSurfaceFrame,
    metrics: CanvasSurfaceMetrics
  ): DirtyRegion | undefined {
    if (!damage || damage.requiresFullTextRepaint || damage.requiresFullGraphicsReplay) {
      return undefined;
    }

    const rects: DirtyRect[] = [];
    const rows = new Map<number, DirtyRowRanges>();
    for (const [row, ranges] of damage.textRows) {
      if (row < 0 || row >= frame.height) {
        continue;
      }
      if (ranges.length === 0) {
        rects.push(cellRect(metrics, 0, row, frame.width));
        rows.set(row, "full");
        continue;
      }
      const rowRanges: DirtyCellRange[] = rows.get(row) === "full"
        ? []
        : [...(rows.get(row) as DirtyCellRange[] | undefined ?? [])];
      for (const [start, end] of ranges) {
        const lowerBound = Math.max(0, Math.min(frame.width, Math.floor(start)));
        const upperBound = Math.max(lowerBound, Math.min(frame.width, Math.ceil(end)));
        if (lowerBound >= upperBound) {
          continue;
        }
        rects.push(cellRect(metrics, lowerBound, row, upperBound - lowerBound));
        rowRanges.push({ start: lowerBound, end: upperBound });
      }
      if (rows.get(row) !== "full" && rowRanges.length > 0) {
        rows.set(row, normalizeCellRanges(rowRanges));
      }
    }
    return { rects, rows };
  }

  private drawTextLine(
    context: CanvasRenderingContext2D,
    metrics: CanvasSurfaceMetrics,
    x: number,
    y: number,
    width: number,
    line: WebHostSurfaceStyle["underline"],
    placement: "underline" | "strike",
    fallbackColor: string
  ): void {
    if (!line) {
      return;
    }
    context.strokeStyle = line.color ?? fallbackColor;
    context.lineWidth = line.pattern === "double" ? 2 : 1;
    if (line.pattern === "dot") {
      context.setLineDash([1, 3]);
    } else if (line.pattern === "dash") {
      context.setLineDash([4, 3]);
    } else {
      context.setLineDash([]);
    }

    const lineY = placement === "underline"
      ? y + metrics.cellHeight - 2
      : y + Math.floor(metrics.cellHeight / 2);
    context.beginPath();
    context.moveTo(x, lineY);
    context.lineTo(x + width, lineY);
    context.stroke();
    context.setLineDash([]);
  }
}

/**
 * The CSS font string for a cell, folding the surface emphasis bits (bold,
 * italic) over the host terminal's font size/family. Exposed so the host can
 * reuse the exact same metric when measuring cell dimensions.
 */
export function fontForStyle(
  terminalStyle: ResolvedWebHostTerminalStyle,
  style?: WebHostSurfaceStyle | null
): string {
  const emphasis = style?.em ?? 0;
  const italic = (emphasis & 2) !== 0 ? "italic " : "";
  const weight = (emphasis & 1) !== 0 ? "700 " : "";
  return `${italic}${weight}${terminalStyle.fontSize}px ${terminalStyle.fontFamily}`;
}

function cellRect(
  metrics: CanvasSurfaceMetrics,
  x: number,
  y: number,
  span: number
): DirtyRect {
  return {
    x: x * metrics.cellWidth,
    y: y * metrics.cellHeight,
    width: Math.max(1, span) * metrics.cellWidth,
    height: metrics.cellHeight,
  };
}

async function decodeImage(
  dataBase64: string,
  format: WebHostSurfaceImageFormat
): Promise<CanvasImageSource> {
  const bytes = decodeBase64Bytes(dataBase64);
  const blob = new Blob([bytes], { type: `image/${format}` });

  if (typeof createImageBitmap === "function") {
    // Animated GIFs collapse to their first frame in createImageBitmap
    // — that matches the Kitty path's first-frame composite. Phase 7
    // will replace this with a frame ticker.
    return createImageBitmap(blob);
  }

  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(blob);
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Failed to decode ${format} image`));
    };
    image.src = url;
  });
}

function decodeBase64Bytes(
  value: string
): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  return new Uint8Array(Buffer.from(value, "base64"));
}

function normalizeCellRanges(
  ranges: DirtyCellRange[]
): DirtyCellRange[] {
  const sorted = ranges
    .filter((range) => range.end > range.start)
    .sort((lhs, rhs) => lhs.start - rhs.start || lhs.end - rhs.end);
  const normalized: DirtyCellRange[] = [];
  for (const range of sorted) {
    const previous = normalized[normalized.length - 1];
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
      continue;
    }
    normalized.push({ ...range });
  }
  return normalized;
}

function cellIntersectsRanges(
  x: number,
  span: number,
  ranges: DirtyRowRanges
): boolean {
  if (ranges === "full") {
    return true;
  }
  const start = Math.floor(x);
  const end = start + Math.max(1, Math.ceil(span));
  return ranges.some((range) => start < range.end && end > range.start);
}

function dirtyRegionIntersectsCellRect(
  region: DirtyRegion,
  x: number,
  y: number,
  width: number,
  height: number
): boolean {
  const startRow = Math.max(0, Math.floor(y));
  const endRow = Math.max(startRow, Math.ceil(y + height));
  const rectRange = {
    start: Math.floor(x),
    end: Math.floor(x) + Math.max(1, Math.ceil(width)),
  };
  for (let row = startRow; row < endRow; row += 1) {
    const ranges = region.rows.get(row);
    if (!ranges) {
      continue;
    }
    if (cellIntersectsRanges(rectRange.start, rectRange.end - rectRange.start, ranges)) {
      return true;
    }
  }
  return false;
}

