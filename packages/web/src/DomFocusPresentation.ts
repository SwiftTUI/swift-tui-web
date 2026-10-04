import type { SurfaceMetrics } from "./SurfaceRenderer.ts";
import type { WebHostSurfaceFrame } from "./WebHostSurfaceTransport.ts";

/** Paint-only focus/caret geometry; browser focus stays with the semantic adapter. */
export class DomFocusPresentation {
  readonly element = document.createElement("div");
  private readonly ring = document.createElement("div");
  private readonly caret = document.createElement("div");
  private hasFocus = false;
  private presentation?: {
    frame: WebHostSurfaceFrame | undefined;
    metrics: SurfaceMetrics;
    offsetX: number;
    offsetY: number;
  };

  constructor(
    private readonly terminal: HTMLElement,
    private readonly selecting: () => boolean,
  ) {
    this.element.className = "webhost-scene__focus-layer";
    this.element.setAttribute("aria-hidden", "true");
    Object.assign(this.element.style, {
      position: "absolute",
      pointerEvents: "none",
      userSelect: "none",
      zIndex: "3",
      boxSizing: "border-box",
      margin: "0",
      padding: "0",
      border: "0",
    });
    this.ring.className = "webhost-scene__focus-ring";
    this.caret.className = "webhost-scene__caret";
    for (const item of [this.ring, this.caret])
      Object.assign(item.style, {
        position: "absolute",
        boxSizing: "border-box",
        margin: "0",
        padding: "0",
        border: "0",
        minWidth: "0",
        maxWidth: "none",
        minHeight: "0",
        maxHeight: "none",
        pointerEvents: "none",
      });
    this.element.append(this.ring, this.caret);
    this.element.hidden = true;
    terminal.appendChild(this.element);
    terminal.addEventListener("focusin", this.refresh);
    terminal.addEventListener("focusout", this.refresh);
  }

  readonly refresh = () => {
    if (this.presentation) this.paintFocus();
    this.element.hidden =
      !this.hasFocus ||
      this.selecting() ||
      !this.terminal.contains?.(document.activeElement);
    this.element.style.display = this.element.hidden ? "none" : "block";
  };

  present(
    frame: WebHostSurfaceFrame | undefined,
    metrics: SurfaceMetrics,
    offsetX = 0,
    offsetY = 0,
  ): void {
    this.presentation = { frame, metrics, offsetX, offsetY };
    this.refresh();
  }

  private paintFocus(): void {
    const { frame, metrics, offsetX, offsetY } = this.presentation!;
    const active = document.activeElement?.closest<HTMLElement>(
      "[data-accessibility-id]",
    );
    const activeID =
      active && this.terminal.contains(active)
        ? active.dataset.accessibilityId
        : undefined;
    const focused = frame?.accessibilityTree?.find(
      (node) =>
        !node.hidden && (activeID ? node.id === activeID : node.isFocused),
    );
    this.hasFocus = focused !== undefined;
    this.element.style.left = `${offsetX}px`;
    this.element.style.top = `${offsetY}px`;
    this.element.style.width = `${metrics.columns * metrics.cellWidth}px`;
    this.element.style.height = `${metrics.rows * metrics.cellHeight}px`;
    this.element.style.overflow = "hidden";
    if (focused) {
      const [x, y, width, height] = focused.rect;
      const forced = globalThis.matchMedia?.("(forced-colors: active)").matches;
      const color = forced
        ? "CanvasText"
        : focusColor(metrics.style.theme.background);
      const companionColor = forced
        ? "Canvas"
        : color === "#000000"
          ? "#ffffff"
          : "#000000";
      Object.assign(this.ring.style, {
        left: `${x * metrics.cellWidth}px`,
        top: `${y * metrics.cellHeight}px`,
        width: `${Math.max(1, width) * metrics.cellWidth}px`,
        height: `${Math.max(1, height) * metrics.cellHeight}px`,
        outline: `2px solid ${color}`,
        outlineOffset: "-2px",
        boxShadow: `inset 0 0 0 4px ${companionColor}`,
        forcedColorAdjust: "none",
      });
      const anchor = focused.cursorAnchor;
      this.caret.hidden =
        !anchor ||
        !focused.isFocused ||
        focused.isEnabled === false ||
        !["textField", "textEditor", "secureField"].includes(focused.role);
      this.caret.style.display = this.caret.hidden ? "none" : "block";
      if (anchor)
        Object.assign(this.caret.style, {
          left: `${anchor[0] * metrics.cellWidth}px`,
          top: `${anchor[1] * metrics.cellHeight}px`,
          width: "2px",
          height: `${metrics.cellHeight}px`,
          background: color,
          boxShadow: `1px 0 0 ${companionColor}`,
          forcedColorAdjust: "none",
        });
    }
  }

  dispose(): void {
    this.terminal.removeEventListener("focusin", this.refresh);
    this.terminal.removeEventListener("focusout", this.refresh);
    this.hasFocus = false;
    this.presentation = undefined;
    this.element.remove();
  }
}

// Black or white always supplies at least 4.5:1 against an opaque sRGB color.
// The adjacent opposite band also keeps the outline visible over a selected
// cell or custom graphic whose background differs from the host theme.
function focusColor(background: string): string {
  const hex = background.match(/^#([\da-f]{6})/i)?.[1];
  if (!hex) return "#ffffff";
  const channels = [0, 2, 4]
    .map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((value) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
    );
  const luminance =
    channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05)
    ? "#000000"
    : "#ffffff";
}
