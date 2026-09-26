import type { SurfaceMetrics } from "./SurfaceRenderer.ts";
import type { WebHostSurfaceFrame } from "./WebHostSurfaceTransport.ts";

/** Paint-only focus/caret geometry; browser focus stays with the semantic adapter. */
export class DomFocusPresentation {
  readonly element = document.createElement("div");
  private readonly ring = document.createElement("div");
  private readonly caret = document.createElement("div");
  private hasFocus = false;

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
    const focused = frame?.accessibilityTree?.find(
      (node) => node.isFocused && !node.hidden,
    );
    this.hasFocus = focused !== undefined && focused.isEnabled !== false;
    this.element.style.left = `${offsetX}px`;
    this.element.style.top = `${offsetY}px`;
    this.element.style.width = `${metrics.columns * metrics.cellWidth}px`;
    this.element.style.height = `${metrics.rows * metrics.cellHeight}px`;
    this.element.style.overflow = "hidden";
    if (focused) {
      const [x, y, width, height] = focused.rect;
      const color = globalThis.matchMedia?.("(forced-colors: active)").matches
        ? "CanvasText"
        : metrics.style.theme.foreground;
      Object.assign(this.ring.style, {
        left: `${x * metrics.cellWidth}px`,
        top: `${y * metrics.cellHeight}px`,
        width: `${Math.max(1, width) * metrics.cellWidth}px`,
        height: `${Math.max(1, height) * metrics.cellHeight}px`,
        outline: `2px solid ${color}`,
        outlineOffset: "-2px",
        forcedColorAdjust: "none",
      });
      const anchor = focused.cursorAnchor;
      this.caret.hidden =
        !anchor ||
        !["textField", "textEditor", "secureField"].includes(focused.role);
      this.caret.style.display = this.caret.hidden ? "none" : "block";
      if (anchor)
        Object.assign(this.caret.style, {
          left: `${anchor[0] * metrics.cellWidth}px`,
          top: `${anchor[1] * metrics.cellHeight}px`,
          width: "2px",
          height: `${metrics.cellHeight}px`,
          background: color,
          forcedColorAdjust: "none",
        });
    }
    this.refresh();
  }

  dispose(): void {
    this.terminal.removeEventListener("focusin", this.refresh);
    this.terminal.removeEventListener("focusout", this.refresh);
    this.hasFocus = false;
    this.element.remove();
  }
}
