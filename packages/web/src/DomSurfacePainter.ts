import { fontForStyle } from "./CanvasSurfacePainter.ts";
import {
  resolvedSurfaceBackground,
  resolvedSurfaceForeground,
  type SurfaceMetrics,
  type WebHostSurfacePainter,
} from "./SurfaceRenderer.ts";
import { webTUITerminalBackgroundColor } from "./WebHostTerminalStyle.ts";
import type {
  WebHostSurfaceDamage,
  WebHostSurfaceFrame,
  WebHostSurfaceImage,
  WebHostSurfaceLineStyle,
  WebHostSurfaceStyle,
} from "./WebHostSurfaceTransport.ts";

interface RenderedImage {
  container: HTMLElement;
  image: HTMLElement;
  source: string;
}

/**
 * Draws SwiftTUI surface frames as a DOM element tree instead of canvas
 * pixels: one absolutely positioned row container per grid row, one `<span>`
 * per styled cell run, and `<img>` elements for surface images.
 *
 * Rendering cells as real text buys what canvas cannot offer — the browser's
 * own font shaping and fallback (emoji, CJK), crisp text at any page zoom, an
 * inspectable tree, and native text selection — at the cost of pixel-exact
 * box-drawing seams, which render as font glyphs here rather than the canvas
 * painter's hand-drawn strokes.
 *
 * Damage handling mirrors the canvas painter at row granularity: a frame
 * carrying scoped damage rebuilds only the touched rows' elements; geometry
 * or style changes force a full rebuild. Grid alignment across a run is kept
 * exact by stretching each glyph advance to the cell width via
 * `letter-spacing`, measured once per font/size pair.
 */
export class DomSurfacePainter implements WebHostSurfacePainter {
  private root?: HTMLElement;
  private rowsLayer?: HTMLElement;
  private imagesLayer?: HTMLElement;
  private rowElements: HTMLElement[] = [];
  private renderedImages = new Map<string, RenderedImage>();
  private appliedMetricsKey?: string;
  private renderedGridKey?: string;
  private hasRenderedFrame = false;
  private letterSpacing?: { key: string; value: string };

  /**
   * Binds the container the painter renders into. The runtime owns the
   * container's size; the painter owns everything inside it.
   */
  attach(
    root: HTMLElement
  ): void {
    this.root = root;

    const rowsLayer = createElement("div");
    rowsLayer.className = "webhost-scene__surface-rows";
    fillContainer(rowsLayer.style);

    const imagesLayer = createElement("div");
    imagesLayer.className = "webhost-scene__surface-images";
    fillContainer(imagesLayer.style);
    imagesLayer.style.pointerEvents = "none";

    this.rowsLayer = rowsLayer;
    this.imagesLayer = imagesLayer;
    root.replaceChildren(rowsLayer, imagesLayer);
    this.rowElements = [];
    this.renderedImages = new Map();
    this.appliedMetricsKey = undefined;
    this.renderedGridKey = undefined;
    this.hasRenderedFrame = false;
  }

  paint(
    metrics: SurfaceMetrics,
    frame: WebHostSurfaceFrame | undefined,
    damage?: WebHostSurfaceDamage
  ): void {
    const root = this.root;
    const rowsLayer = this.rowsLayer;
    if (!root || !rowsLayer) {
      return;
    }

    const metricsKey = metricsKeyFor(metrics);
    const metricsChanged = metricsKey !== this.appliedMetricsKey;
    if (metricsChanged) {
      this.applyRootStyle(root, metrics);
      this.appliedMetricsKey = metricsKey;
    }

    if (!frame) {
      this.rowElements = [];
      rowsLayer.replaceChildren();
      this.reconcileImages([], metrics);
      this.renderedGridKey = undefined;
      this.hasRenderedFrame = false;
      return;
    }

    const gridKey = `${frame.width}x${frame.height}x${frame.rows.length}`;
    const fullRepaint = metricsChanged
      || !this.hasRenderedFrame
      || gridKey !== this.renderedGridKey
      || !damage
      || damage.requiresFullTextRepaint
      || damage.requiresFullGraphicsReplay;
    this.renderedGridKey = gridKey;

    if (fullRepaint) {
      for (let y = this.rowElements.length; y > frame.rows.length; y -= 1) {
        this.rowElements[y - 1]?.remove();
      }
      this.rowElements.length = Math.min(this.rowElements.length, frame.rows.length);
      for (let y = 0; y < frame.rows.length; y += 1) {
        this.rebuildRow(y, frame, metrics);
      }
    } else {
      for (const [row] of damage.textRows) {
        if (row < 0 || row >= frame.rows.length) {
          continue;
        }
        this.rebuildRow(row, frame, metrics);
      }
    }

    this.reconcileImages(frame.images ?? [], metrics);
    this.hasRenderedFrame = true;
  }

  private rebuildRow(
    y: number,
    frame: WebHostSurfaceFrame,
    metrics: SurfaceMetrics
  ): void {
    const rowElement = this.ensureRowElement(y, metrics);
    const children: HTMLElement[] = [];
    for (const [x, text, span, styleIndex] of frame.rows[y] ?? []) {
      const cellElement = buildCellElement(
        x,
        text,
        span,
        frame.styles[styleIndex] ?? undefined,
        metrics
      );
      if (cellElement) {
        children.push(cellElement);
      }
    }
    rowElement.replaceChildren(...children);
  }

  private ensureRowElement(
    y: number,
    metrics: SurfaceMetrics
  ): HTMLElement {
    let rowElement = this.rowElements[y];
    if (!rowElement) {
      rowElement = createElement("div");
      rowElement.className = "webhost-scene__surface-row";
      rowElement.style.position = "absolute";
      rowElement.style.left = "0";
      this.rowElements[y] = rowElement;
      this.rowsLayer?.appendChild(rowElement);
    }
    rowElement.style.top = `${y * metrics.cellHeight}px`;
    rowElement.style.height = `${metrics.cellHeight}px`;
    rowElement.style.width = `${metrics.columns * metrics.cellWidth}px`;
    return rowElement;
  }

  private applyRootStyle(
    root: HTMLElement,
    metrics: SurfaceMetrics
  ): void {
    const style = root.style;
    style.position = "relative";
    style.overflow = "hidden";
    style.background = webTUITerminalBackgroundColor(metrics.style);
    style.font = fontForStyle(metrics.style);
    // Set after `font`: the shorthand resets line-height, and the grid needs
    // every row to be exactly one cell tall.
    style.lineHeight = `${metrics.cellHeight}px`;
    style.letterSpacing = this.letterSpacingFor(metrics);
    // Ligature-capable monospace fonts would merge runs like "->" into one
    // glyph and break the column grid.
    style.fontVariantLigatures = "none";
    style.userSelect = "text";
  }

  /**
   * The per-glyph advance correction that stretches the font's natural
   * monospace advance to exactly `cellWidth`, so long runs stay on the cell
   * grid instead of drifting by the sub-pixel remainder of the runtime's
   * ceil'd cell measurement.
   */
  private letterSpacingFor(
    metrics: SurfaceMetrics
  ): string {
    const font = fontForStyle(metrics.style);
    const key = `${font}|${metrics.cellWidth}`;
    if (this.letterSpacing?.key === key) {
      return this.letterSpacing.value;
    }

    let value = "0px";
    const canvas = createElement("canvas") as HTMLCanvasElement;
    const context = canvas.getContext?.("2d");
    if (context) {
      context.font = font;
      const advance = context.measureText("W").width;
      const correction = metrics.cellWidth - advance;
      if (advance > 0 && Math.abs(correction) >= 0.01) {
        value = `${Math.round(correction * 1000) / 1000}px`;
      }
    }

    this.letterSpacing = { key, value };
    return value;
  }

  private reconcileImages(
    images: WebHostSurfaceImage[],
    metrics: SurfaceMetrics
  ): void {
    const layer = this.imagesLayer;
    if (!layer) {
      return;
    }

    const next = new Map<string, RenderedImage>();
    for (const image of images) {
      const [boundsX, boundsY, boundsWidth, boundsHeight] = image.bounds;
      const [clipX, clipY, clipWidth, clipHeight] = image.visibleBounds;
      if (
        !image.dataBase64
        || boundsWidth <= 0
        || boundsHeight <= 0
        || clipWidth <= 0
        || clipHeight <= 0
      ) {
        continue;
      }

      const existing = this.renderedImages.get(image.id);
      const entry = existing ?? makeImageEntry();
      entry.container.style.left = `${clipX * metrics.cellWidth}px`;
      entry.container.style.top = `${clipY * metrics.cellHeight}px`;
      entry.container.style.width = `${clipWidth * metrics.cellWidth}px`;
      entry.container.style.height = `${clipHeight * metrics.cellHeight}px`;
      entry.image.style.left = `${(boundsX - clipX) * metrics.cellWidth}px`;
      entry.image.style.top = `${(boundsY - clipY) * metrics.cellHeight}px`;
      entry.image.style.width = `${boundsWidth * metrics.cellWidth}px`;
      entry.image.style.height = `${boundsHeight * metrics.cellHeight}px`;

      const source = `data:image/${image.format};base64,${image.dataBase64}`;
      if (entry.source !== source) {
        entry.image.setAttribute("src", source);
        entry.source = source;
      }
      if (!existing) {
        layer.appendChild(entry.container);
      }
      next.set(image.id, entry);
    }

    for (const [id, entry] of this.renderedImages) {
      if (!next.has(id)) {
        entry.container.remove();
      }
    }
    this.renderedImages = next;
  }
}

/**
 * A change key over everything the rendered tree bakes into element styles —
 * grid geometry, font, and theme colors. A key change invalidates every
 * rendered row, so the next paint restyles the root and rebuilds in full.
 */
function metricsKeyFor(
  metrics: SurfaceMetrics
): string {
  return [
    metrics.columns,
    metrics.rows,
    metrics.cellWidth,
    metrics.cellHeight,
    fontForStyle(metrics.style),
    metrics.style.theme.foreground,
    metrics.style.theme.background,
    metrics.style.theme.windowBackground,
    metrics.style.backgroundOpacity,
  ].join("|");
}

function buildCellElement(
  x: number,
  text: string,
  span: number,
  style: WebHostSurfaceStyle | undefined,
  metrics: SurfaceMetrics
): HTMLElement | undefined {
  const background = resolvedSurfaceBackground(style, metrics.style);
  const hasDecoration = Boolean(style?.underline || style?.strikethrough);
  if (!background && !hasDecoration && text.trim() === "") {
    return undefined;
  }

  const element = createElement("span");
  element.textContent = text;
  const elementStyle = element.style;
  elementStyle.position = "absolute";
  elementStyle.left = `${x * metrics.cellWidth}px`;
  elementStyle.top = "0";
  elementStyle.width = `${Math.max(1, span) * metrics.cellWidth}px`;
  elementStyle.height = "100%";
  elementStyle.whiteSpace = "pre";
  elementStyle.color = resolvedSurfaceForeground(style, metrics.style);
  if (background) {
    elementStyle.backgroundColor = background;
  }

  const emphasis = style?.em ?? 0;
  if (emphasis & 1) {
    elementStyle.fontWeight = "700";
  }
  if (emphasis & 2) {
    elementStyle.fontStyle = "italic";
  }

  const opacity = style?.opacity ?? 1;
  if (opacity !== 1) {
    elementStyle.opacity = String(opacity);
  }

  applyTextDecoration(elementStyle, style);
  return element;
}

function applyTextDecoration(
  elementStyle: CSSStyleDeclaration,
  style: WebHostSurfaceStyle | undefined
): void {
  const lines: string[] = [];
  if (style?.underline) {
    lines.push("underline");
  }
  if (style?.strikethrough) {
    lines.push("line-through");
  }
  if (lines.length === 0) {
    return;
  }

  elementStyle.textDecorationLine = lines.join(" ");
  const pattern = style?.underline?.pattern ?? style?.strikethrough?.pattern;
  elementStyle.textDecorationStyle = decorationStyleFor(pattern);
  // CSS shares one decoration color across both lines; the underline's color
  // wins when the app styles them differently.
  const color = style?.underline?.color ?? style?.strikethrough?.color;
  if (color) {
    elementStyle.textDecorationColor = color;
  }
}

function decorationStyleFor(
  pattern: WebHostSurfaceLineStyle["pattern"] | undefined
): string {
  switch (pattern) {
  case "dot":
    return "dotted";
  case "dash":
  case "dashDot":
  case "dashDotDot":
    return "dashed";
  case "double":
    return "double";
  case "curly":
    return "wavy";
  default:
    return "solid";
  }
}

function fillContainer(
  style: CSSStyleDeclaration
): void {
  style.position = "absolute";
  style.left = "0";
  style.top = "0";
  style.width = "100%";
  style.height = "100%";
}

function makeImageEntry(): RenderedImage {
  const container = createElement("div");
  container.className = "webhost-scene__surface-image";
  container.style.position = "absolute";
  container.style.overflow = "hidden";

  const image = createElement("img");
  image.style.position = "absolute";
  image.setAttribute("alt", "");
  image.setAttribute("draggable", "false");
  container.appendChild(image);
  return { container, image, source: "" };
}

function createElement(
  tagName: string
): HTMLElement {
  if (typeof document === "undefined") {
    throw new Error("document is not available");
  }
  return document.createElement(tagName);
}
