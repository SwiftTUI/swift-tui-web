import {
  applyWebHostTerminalStyle,
  normalizeWebHostTerminalStyle,
  type ResolvedWebHostTerminalStyle,
  type WebHostTerminalStyle,
  webTUITerminalBackgroundColor,
} from "./WebHostTerminalStyle.ts";
import {
  CanvasSurfacePainter,
  fontForStyle,
  type CanvasSurfaceMetrics,
} from "./CanvasSurfacePainter.ts";
import {
  InputEventEncoder,
  type CellLocation,
  type PointerButton,
} from "./InputEventEncoder.ts";
import {
  cellLocationForEvent,
  rawCellLocationForEvent,
  wheelTargetCanScroll,
  type PointerGeometryMetrics,
} from "./PointerGeometry.ts";
import { AccessibilityTreeMounter } from "./AccessibilityTree.ts";
import {
  type WebHostFrameDiagnosticRecord,
  type WebHostOutputSink,
  type WebHostRuntimeIssue,
  type WebHostSurfaceDamage,
  type WebHostSurfaceFrame,
} from "./WebHostSurfaceTransport.ts";
import type { WebHostSceneDescriptor } from "./WebHostSceneManifest.ts";

export interface WebHostSceneBridge {
  bindOutput(sink: WebHostOutputSink): void;
  resize(columns: number, rows: number, cellWidth?: number, cellHeight?: number): void;
  updateRenderStyle(style: WebHostTerminalStyle): void;
  sendInput(chunk: Uint8Array): void;
  dispose(): void;
}

export interface WebHostSceneRuntimeOptions {
  mount: HTMLElement;
  descriptor: WebHostSceneDescriptor;
  style: WebHostTerminalStyle;
  bridge?: WebHostSceneBridge;
  onInput(chunk: Uint8Array): void;
  onFrameDiagnostic?: (diagnostic: WebHostFrameDiagnosticRecord) => void;
  synchronizeAccessibilityFocus?: boolean;
  /**
   * How the embedded view treats mouse-wheel input.
   * - `"chain"` (default): forward the wheel only while a scrollable region
   *   under the pointer can still scroll in that direction; otherwise let it
   *   fall through so the page (or parent iframe) scrolls — iframe-like nested
   *   scrolling. A scene with no `ScrollView` never traps the wheel. Uses the
   *   `scrollRegions` the app publishes in its frames.
   * - `"capture"`: always forward the wheel to the app while the pointer is over
   *   the surface (and `preventDefault` page scroll). Best for full-screen apps
   *   where there is no page to scroll past.
   * - `"passive"`: never capture; the page always scrolls.
   *
   * Takes precedence over the legacy `captureWheelInput` flag.
   */
  wheelMode?: WheelMode;
  /**
   * Legacy boolean wheel gate. `true` → `"capture"`, `false` → `"passive"`.
   * Prefer `wheelMode`. Ignored when `wheelMode` is set. When neither is set the
   * mode defaults to `"chain"`.
   */
  captureWheelInput?: boolean;
}

export type WheelMode = "capture" | "chain" | "passive";

/**
 * Resolves the legacy `captureWheelInput` flag to a {@link WheelMode}. When the
 * flag is unset the mode defaults to `"chain"`, so embeds never trap a visitor
 * who is merely scrolling past the view; `true` maps to `"capture"` and `false`
 * to `"passive"` to preserve the old boolean behavior.
 */
function legacyWheelMode(captureWheelInput: boolean | undefined): WheelMode {
  if (captureWheelInput === undefined) {
    return "chain";
  }
  return captureWheelInput ? "capture" : "passive";
}

/**
 * Coordinates a single SwiftTUI scene's browser presentation: it owns the DOM
 * mount, canvas, accessibility tree, and bridge wiring, and delegates the heavy
 * responsibilities to focused collaborators — {@link CanvasSurfacePainter} for
 * canvas drawing, {@link InputEventEncoder} for wire-message encoding, and the
 * {@link PointerGeometry} helpers for pixel→cell hit-testing and wheel chaining.
 */
export class WebHostSceneRuntime {
  readonly descriptor: WebHostSceneDescriptor;
  readonly element: HTMLElement;
  readonly terminalMount: HTMLElement;

  private readonly bridge?: WebHostSceneBridge;
  private readonly onInput: (chunk: Uint8Array) => void;
  private readonly onFrameDiagnostic?: (diagnostic: WebHostFrameDiagnosticRecord) => void;
  private readonly synchronizeAccessibilityFocus: boolean;
  private readonly wheelMode: WheelMode;
  private readonly painter = new CanvasSurfacePainter();
  private readonly inputEncoder = new InputEventEncoder();
  private currentStyle: ResolvedWebHostTerminalStyle;
  private canvas?: HTMLCanvasElement;
  private accessibilityTree?: AccessibilityTreeMounter;
  private diagnosticText?: HTMLElement;
  private resizeObserver?: ResizeObserver;
  private detachInputHandlers?: () => void;
  private currentFrame?: WebHostSurfaceFrame;
  private columns = 80;
  private rows = 24;
  private cellWidth = 8;
  private cellHeight = 18;
  private activePointerButton: PointerButton = "primary";
  private hasCapturedPointer = false;
  private lastSentResize?: {
    columns: number;
    rows: number;
    cellWidth: number;
    cellHeight: number;
  };
  private isVisible = false;

  constructor(options: WebHostSceneRuntimeOptions) {
    this.descriptor = options.descriptor;
    this.currentStyle = normalizeWebHostTerminalStyle(options.style);
    this.bridge = options.bridge;
    this.onInput = options.onInput;
    this.onFrameDiagnostic = options.onFrameDiagnostic;
    this.synchronizeAccessibilityFocus = options.synchronizeAccessibilityFocus ?? true;
    this.wheelMode = options.wheelMode ?? legacyWheelMode(options.captureWheelInput);
    this.element = document.createElement("section");
    this.element.className = "webhost-scene";
    this.element.dataset.sceneId = options.descriptor.id;
    this.element.hidden = true;

    const header = document.createElement("div");
    header.className = "webhost-scene__header";
    header.textContent = options.descriptor.title ?? options.descriptor.id;

    this.terminalMount = document.createElement("div");
    this.terminalMount.className = "webhost-scene__terminal";
    this.terminalMount.tabIndex = 0;

    this.element.append(header, this.terminalMount);
    options.mount.appendChild(this.element);
    this.applyVisibility();
  }

  async mount(): Promise<void> {
    if (this.canvas) {
      return;
    }

    const canvas = document.createElement("canvas");
    canvas.className = "webhost-scene__surface";
    canvas.setAttribute("aria-hidden", "true");
    this.canvas = canvas;
    this.painter.attach(canvas, () => this.draw());
    this.accessibilityTree = new AccessibilityTreeMounter();
    this.terminalMount.replaceChildren(
      canvas,
      this.accessibilityTree.element,
      this.accessibilityTree.announcerElement
    );
    this.installInputHandlers();
    this.installResizeObserver();

    this.bridge?.bindOutput({
      presentSurface: (frame) => this.presentSurface(frame),
      writeClipboard: (text) => this.writeClipboard(text),
      notifyRuntimeIssue: (issue) => this.notifyRuntimeIssue(issue),
      recordFrameDiagnostic: (diagnostic) => this.recordFrameDiagnostic(diagnostic),
      writeOutput: (text) => this.writeOutput(text),
      writeError: (text) => this.writeOutput(text),
    });

    this.applyStyle(this.currentStyle);
    this.measureCells();
    this.resizeToMount();
    this.draw();
    this.syncAccessibilityTree();
  }

  setVisible(
    visible: boolean
  ): void {
    this.isVisible = visible;
    this.applyVisibility();
    if (visible) {
      this.resizeToMount();
      if (this.synchronizeAccessibilityFocus) {
        this.terminalMount.focus?.({ preventScroll: true });
      }
    }
  }

  setStyle(
    style: WebHostTerminalStyle
  ): void {
    this.currentStyle = normalizeWebHostTerminalStyle(style);
    this.applyStyle(this.currentStyle);
    this.bridge?.updateRenderStyle(this.currentStyle);
    this.measureCells();
    this.resizeToMount();
    this.draw();
    this.syncAccessibilityTree();
  }

  resize(
    columns: number,
    rows: number
  ): void {
    this.columns = Math.max(1, Math.round(columns));
    this.rows = Math.max(1, Math.round(rows));
    this.resizeCanvas();
    this.draw();
    this.syncAccessibilityTree();
  }

  writeOutput(
    text: string
  ): void {
    if (!this.diagnosticText) {
      const diagnosticText = document.createElement("pre");
      diagnosticText.className = "webhost-scene__diagnostic";
      this.diagnosticText = diagnosticText;
      this.terminalMount.appendChild(diagnosticText);
    }
    this.diagnosticText.textContent = `${this.diagnosticText.textContent ?? ""}${text}`;
  }

  notifyRuntimeIssue(
    issue: WebHostRuntimeIssue
  ): void {
    console.log(issue.description);
  }

  private recordFrameDiagnostic(
    diagnostic: WebHostFrameDiagnosticRecord
  ): void {
    this.onFrameDiagnostic?.(diagnostic);
  }

  async writeClipboard(
    text: string
  ): Promise<void> {
    const clipboard = globalThis.navigator?.clipboard;
    if (!clipboard?.writeText) {
      return;
    }

    try {
      await clipboard.writeText(text);
    } catch {
      // Clipboard permissions are browser/user-gesture dependent; hosts treat
      // rejection as a best-effort no-op rather than surfacing diagnostics.
    }
  }

  sendInput(
    chunk: Uint8Array
  ): void {
    this.onInput(chunk);
  }

  dispose(): void {
    this.detachInputHandlers?.();
    this.resizeObserver?.disconnect();
    this.element.remove();
  }

  private presentSurface(
    frame: WebHostSurfaceFrame
  ): void {
    const previousFrame = this.currentFrame;
    this.currentFrame = frame;
    this.columns = Math.max(1, Math.round(frame.width));
    this.rows = Math.max(1, Math.round(frame.height));
    const resized = this.resizeCanvas();
    this.draw(previousFrame && !resized ? frame.damage : undefined);
    this.syncAccessibilityTree();
  }

  private applyStyle(
    style: WebHostTerminalStyle
  ): void {
    applyWebHostTerminalStyle(this.element, style);
    this.element.style.padding = "0.75rem";
    this.element.style.borderRadius = "16px";
    this.element.style.boxShadow = "0 20px 50px rgba(0, 0, 0, 0.28)";
    this.element.style.overflow = "hidden";
    this.element.style.gap = "0.5rem";
    this.element.style.gridTemplateRows = "auto 1fr";

    this.terminalMount.style.position = "relative";
    this.terminalMount.style.overflow = "hidden";
    // Keep a captured wheel from rubber-banding/chaining the page; the wheel
    // capture vs. fall-through decision lives in handleWheel.
    this.terminalMount.style.overscrollBehavior = "contain";
    this.terminalMount.style.outline = "none";
    this.terminalMount.style.background = webTUITerminalBackgroundColor(this.currentStyle);
    this.terminalMount.style.minHeight = `${this.cellHeight * 8}px`;

    if (this.canvas) {
      this.canvas.style.display = "block";
      this.canvas.style.width = "100%";
      this.canvas.style.height = "100%";
    }
  }

  private applyVisibility(): void {
    this.element.hidden = !this.isVisible;
    this.element.style.setProperty(
      "display",
      this.isVisible ? "grid" : "none",
      "important"
    );
  }

  private installResizeObserver(): void {
    if (typeof ResizeObserver === "undefined") {
      return;
    }

    this.resizeObserver = new ResizeObserver(() => {
      this.resizeToMount();
    });
    this.resizeObserver.observe(this.terminalMount);
  }

  private installInputHandlers(): void {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.isComposing) {
        return;
      }
      const message = this.inputEncoder.encodeKey(event);
      if (!message) {
        return;
      }

      this.onInput(message);
      event.preventDefault();
    };

    const handlePaste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (!text) {
        return;
      }
      this.onInput(this.inputEncoder.encodePaste(text));
      event.preventDefault();
    };

    const handlePointerDown = (event: PointerEvent) => {
      const location = this.cellLocation(event);
      if (!location) {
        return;
      }

      const button = this.inputEncoder.pointerButton(event.button);
      this.activePointerButton = button;
      this.hasCapturedPointer = true;
      this.terminalMount.focus?.({ preventScroll: true });
      this.terminalMount.setPointerCapture?.(event.pointerId);
      this.onInput(this.inputEncoder.encodePointerDown(location, button, event));
      event.preventDefault();
    };

    const handlePointerUp = (event: PointerEvent) => {
      const location = this.hasCapturedPointer
        ? this.rawCellLocation(event)
        : this.cellLocation(event);
      this.terminalMount.releasePointerCapture?.(event.pointerId);
      this.hasCapturedPointer = false;
      if (!location) {
        return;
      }

      const button = this.inputEncoder.pointerButton(event.button) ?? this.activePointerButton;
      this.onInput(this.inputEncoder.encodePointerUp(location, button, event));
      event.preventDefault();
    };

    const handlePointerMove = (event: PointerEvent) => {
      const location = event.buttons && this.hasCapturedPointer
        ? this.rawCellLocation(event)
        : this.cellLocation(event);
      if (!location) {
        return;
      }

      this.onInput(this.inputEncoder.encodePointerMove(location, this.activePointerButton, event));
    };

    const handleWheel = (event: WheelEvent) => {
      if (this.wheelMode === "passive") {
        return;
      }

      const location = this.cellLocation(event);
      if (!location) {
        // Pointer is outside the cell grid (sub-cell margin / gutter). Don't
        // capture — let the wheel fall through to the page.
        return;
      }

      // In "chain" mode, capture only while a scrollable region under the
      // pointer can still move in this direction; otherwise let the wheel fall
      // through so the page (or parent iframe) scrolls — iframe-like behavior.
      // "capture" mode always forwards while over the surface (legacy).
      if (this.wheelMode === "chain"
        && !wheelTargetCanScroll(this.currentFrame?.scrollRegions, location, event.deltaX, event.deltaY)) {
        return;
      }

      this.onInput(this.inputEncoder.encodeWheel(location, event));
      event.preventDefault();
    };

    this.terminalMount.addEventListener("keydown", handleKeyDown);
    this.terminalMount.addEventListener("paste", handlePaste);
    this.terminalMount.addEventListener("pointerdown", handlePointerDown);
    this.terminalMount.addEventListener("pointerup", handlePointerUp);
    this.terminalMount.addEventListener("pointermove", handlePointerMove);
    this.terminalMount.addEventListener("wheel", handleWheel, { passive: false });

    this.detachInputHandlers = () => {
      this.terminalMount.removeEventListener("keydown", handleKeyDown);
      this.terminalMount.removeEventListener("paste", handlePaste);
      this.terminalMount.removeEventListener("pointerdown", handlePointerDown);
      this.terminalMount.removeEventListener("pointerup", handlePointerUp);
      this.terminalMount.removeEventListener("pointermove", handlePointerMove);
      this.terminalMount.removeEventListener("wheel", handleWheel);
    };
  }

  private resizeToMount(): void {
    this.measureCells();
    const rect = this.terminalMount.getBoundingClientRect?.();
    const width = rect?.width && rect.width > 0 ? rect.width : this.columns * this.cellWidth;
    const height = rect?.height && rect.height > 0 ? rect.height : this.rows * this.cellHeight;
    const nextColumns = Math.max(1, Math.floor(width / this.cellWidth));
    const nextRows = Math.max(1, Math.floor(height / this.cellHeight));

    this.columns = nextColumns;
    this.rows = nextRows;
    this.sendResizeIfNeeded();
    this.resizeCanvas();
  }

  private sendResizeIfNeeded(): void {
    const current = {
      columns: this.columns,
      rows: this.rows,
      cellWidth: this.cellWidth,
      cellHeight: this.cellHeight,
    };
    if (this.lastSentResize
      && this.lastSentResize.columns === current.columns
      && this.lastSentResize.rows === current.rows
      && this.lastSentResize.cellWidth === current.cellWidth
      && this.lastSentResize.cellHeight === current.cellHeight
    ) {
      return;
    }

    this.lastSentResize = current;
    this.bridge?.resize(current.columns, current.rows, current.cellWidth, current.cellHeight);
  }

  private resizeCanvas(): boolean {
    if (!this.canvas) {
      return false;
    }

    const cssWidth = Math.max(1, this.columns * this.cellWidth);
    const cssHeight = Math.max(1, this.rows * this.cellHeight);
    const scale = globalThis.window?.devicePixelRatio || 1;
    const width = Math.ceil(cssWidth * scale);
    const height = Math.ceil(cssHeight * scale);
    const styleWidth = `${cssWidth}px`;
    const styleHeight = `${cssHeight}px`;
    if (this.canvas.width === width
      && this.canvas.height === height
      && this.canvas.style.width === styleWidth
      && this.canvas.style.height === styleHeight
    ) {
      return false;
    }

    this.canvas.width = width;
    this.canvas.height = height;
    this.canvas.style.width = styleWidth;
    this.canvas.style.height = styleHeight;
    return true;
  }

  private measureCells(): void {
    const canvas = this.canvas ?? document.createElement("canvas");
    const context = canvas.getContext?.("2d");
    if (!context) {
      this.cellWidth = Math.max(1, Math.round(this.currentStyle.fontSize * 0.62));
      this.cellHeight = Math.max(1, Math.round(this.currentStyle.fontSize * 1.35));
      return;
    }

    context.font = fontForStyle(this.currentStyle);
    this.cellWidth = Math.max(1, Math.ceil(context.measureText("W").width));
    this.cellHeight = Math.max(1, Math.ceil(this.currentStyle.fontSize * 1.35));
  }

  private draw(
    damage?: WebHostSurfaceDamage
  ): void {
    this.painter.paint(this.surfaceMetrics(), this.currentFrame, damage);
  }

  private syncAccessibilityTree(): void {
    const tree = this.accessibilityTree;
    if (!tree || !this.currentFrame) {
      return;
    }

    tree.present(this.currentFrame.accessibilityTree ?? [], {
      cellWidth: this.cellWidth,
      cellHeight: this.cellHeight,
    }, this.currentFrame.accessibilityAnnouncements ?? [], {
      synchronizeFocus: this.synchronizeAccessibilityFocus,
    });
  }

  private surfaceMetrics(): CanvasSurfaceMetrics {
    return {
      columns: this.columns,
      rows: this.rows,
      cellWidth: this.cellWidth,
      cellHeight: this.cellHeight,
      style: this.currentStyle,
    };
  }

  private pointerMetrics(): PointerGeometryMetrics {
    return {
      rect: this.canvas?.getBoundingClientRect?.() ?? this.terminalMount.getBoundingClientRect?.(),
      cellWidth: this.cellWidth,
      cellHeight: this.cellHeight,
      columns: this.columns,
      rows: this.rows,
    };
  }

  private cellLocation(
    event: MouseEvent
  ): CellLocation | undefined {
    return cellLocationForEvent(event, this.pointerMetrics());
  }

  private rawCellLocation(
    event: MouseEvent
  ): CellLocation | undefined {
    return rawCellLocationForEvent(event, this.pointerMetrics());
  }
}
