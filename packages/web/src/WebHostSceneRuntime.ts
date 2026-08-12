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
import { DomSurfacePainter } from "./DomSurfacePainter.ts";
import type { WebHostSurfaceRendererKind } from "./SurfaceRenderer.ts";
import {
  InputEventEncoder,
  type CellLocation,
  type PointerButton,
} from "./InputEventEncoder.ts";
import {
  cellLocationForEvent,
  linkTargetAt,
  rawCellLocationForEvent,
  wheelTargetCanScroll,
  type PointerGeometryMetrics,
} from "./PointerGeometry.ts";
import { AccessibilityTreeMounter } from "./AccessibilityTree.ts";
import { normalizeSemantics } from "./normalizeWireTokens.ts";
import {
  type WebHostFocusPresentation,
  type WebHostFrameDiagnosticRecord,
  type WebHostImagePayloadRequestHandler,
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
  /** Optional for compatibility with custom bridges predating image recovery. */
  requestImagePayloads?: WebHostImagePayloadRequestHandler;
  /**
   * Declares whether this client scrolls by dragging content directly.
   * Optional for compatibility with custom bridges predating the record; an
   * app that never receives it keeps the desktop paradigm.
   */
  updatePointerCapabilities?(supportsScrollPanning: boolean): void;
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
  /**
   * Called when the user clicks a hyperlink cell (a click is a pointer-down
   * and pointer-up over the same link target). When unset, `http(s)` targets
   * open in a new tab via `window.open(url, "_blank", "noopener,noreferrer")`
   * and other schemes are ignored. Mirrors the Android host's tap-to-open.
   */
  onOpenHyperlink?: (url: string) => void;
  /**
   * Whether to suspend the scene's app while it cannot be seen — when the
   * scene is switched to the background (`setVisible(false)`) or the whole
   * document is hidden (`setDocumentVisible(false)`). Suspension parks the
   * app's run loop and freezes its monotonic clock, so a hidden scene costs
   * no CPU and resumes exactly where it left off. Defaults to `true`; set
   * `false` to let background scenes keep running (pre-suspension behavior).
   */
  suspendWhenHidden?: boolean;
  /**
   * Which surface presenter draws the scene's frames. `"canvas"` (default)
   * paints onto a 2D `<canvas>`; `"dom"` renders cells as absolutely
   * positioned text elements — native font rendering and, uniquely, real
   * text selection: hold Alt/Option and drag to select instead of sending
   * pointer input to the app. See {@link WebHostSurfaceRendererKind}.
   */
  renderer?: WebHostSurfaceRendererKind;
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
 * The media query for "the primary pointing device is coarse", i.e. a finger.
 * Deliberately `pointer` and not `any-pointer`: a touch-capable laptop has a
 * coarse pointer *available* but is driven by a trackpad, and it should get
 * the desktop paradigm.
 *
 * Returns `undefined` where `matchMedia` is unavailable (SSR, older embedding
 * hosts, some test environments), which callers read as "desktop".
 */
export function coarsePointerQuery(): MediaQueryList | undefined {
  if (typeof globalThis.matchMedia !== "function") {
    return undefined;
  }
  try {
    return globalThis.matchMedia("(pointer: coarse)");
  } catch {
    return undefined;
  }
}

/** Whether the primary pointing device is a finger rather than a pointer. */
export function coarsePrimaryPointer(): boolean {
  return coarsePointerQuery()?.matches ?? false;
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
  private readonly rendererKind: WebHostSurfaceRendererKind;
  private readonly painter: CanvasSurfacePainter | DomSurfacePainter;
  private readonly inputEncoder = new InputEventEncoder();
  private currentStyle: ResolvedWebHostTerminalStyle;
  private canvas?: HTMLCanvasElement;
  private domSurfaceRoot?: HTMLElement;
  private lastDomSurfaceSize?: { width: number; height: number };
  private accessibilityTree?: AccessibilityTreeMounter;
  private diagnosticText?: HTMLElement;
  private resizeObserver?: ResizeObserver;
  private detachInputHandlers?: () => void;
  private currentFrame?: WebHostSurfaceFrame;
  private columns = 80;
  private rows = 24;
  private cellWidth = 8;
  private cellHeight = 18;
  private surfaceCSSWidth?: number;
  private surfaceCSSHeight?: number;
  private activePointerButton: PointerButton = "primary";
  private hasCapturedPointer = false;
  private readonly onOpenHyperlink?: (url: string) => void;
  private pointerDownLinkTarget?: string;
  private lastSentResize?: {
    columns: number;
    rows: number;
    cellWidth: number;
    cellHeight: number;
  };
  private isVisible = false;
  private documentVisible = true;
  private runtimeSuspended = false;
  private readonly suspendWhenHidden: boolean;
  /**
   * Seeded to `false` rather than left unset because absence of the record
   * already means the desktop paradigm on the Swift side: a mouse-driven
   * client therefore says nothing, and only a client that actually pans by
   * dragging puts a record on the wire.
   */
  private lastSentPointerCapabilities = false;
  private detachPointerParadigmObserver?: () => void;

  constructor(options: WebHostSceneRuntimeOptions) {
    this.descriptor = options.descriptor;
    this.currentStyle = normalizeWebHostTerminalStyle(options.style);
    this.bridge = options.bridge;
    this.onInput = options.onInput;
    this.onFrameDiagnostic = options.onFrameDiagnostic;
    this.synchronizeAccessibilityFocus = options.synchronizeAccessibilityFocus ?? true;
    this.wheelMode = options.wheelMode ?? legacyWheelMode(options.captureWheelInput);
    this.rendererKind = options.renderer ?? "canvas";
    const onImagePayloadMiss = (
      ids: readonly string[]
    ): readonly string[] | void => {
      return this.bridge?.requestImagePayloads?.(ids);
    };
    this.painter = this.rendererKind === "dom"
      ? new DomSurfacePainter({ onImagePayloadMiss })
      : new CanvasSurfacePainter({ onImagePayloadMiss });
    this.onOpenHyperlink = options.onOpenHyperlink;
    this.suspendWhenHidden = options.suspendWhenHidden ?? true;
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
    if (this.surfaceElement) {
      return;
    }

    if (this.painter instanceof DomSurfacePainter) {
      const surfaceRoot = document.createElement("div");
      surfaceRoot.className = "webhost-scene__surface webhost-scene__surface--dom";
      surfaceRoot.setAttribute("aria-hidden", "true");
      this.domSurfaceRoot = surfaceRoot;
      this.painter.attach(surfaceRoot);
    } else {
      const canvas = document.createElement("canvas");
      canvas.className = "webhost-scene__surface";
      canvas.setAttribute("aria-hidden", "true");
      this.canvas = canvas;
      this.painter.attach(canvas, () => this.draw());
    }
    this.accessibilityTree = new AccessibilityTreeMounter();
    this.terminalMount.replaceChildren(
      this.surfaceElement as HTMLElement,
      this.accessibilityTree.element,
      this.accessibilityTree.announcerElement
    );
    this.installInputHandlers();
    this.installResizeObserver();

    this.bridge?.bindOutput({
      presentSurface: (frame, recoveredImagePayloadIds) =>
        this.presentSurface(frame, recoveredImagePayloadIds),
      writeClipboard: (text) => this.writeClipboard(text),
      notifyRuntimeIssue: (issue) => this.notifyRuntimeIssue(issue),
      recordFrameDiagnostic: (diagnostic) => this.recordFrameDiagnostic(diagnostic),
      writeOutput: (text) => this.writeOutput(text),
      writeError: (text) => this.writeOutput(text),
    });

    this.applyStyle(this.currentStyle);
    this.installPointerParadigmObserver();
    this.sendPointerCapabilitiesIfChanged(coarsePrimaryPointer());
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
    this.updateRuntimeSuspension();
  }

  /**
   * Reports whether the surrounding document can be seen at all (browser tab
   * visible, iframe on-screen, …). Combined with the scene-level
   * `setVisible`: the app is suspended while either says hidden, unless
   * `suspendWhenHidden` is `false`.
   */
  setDocumentVisible(
    visible: boolean
  ): void {
    this.documentVisible = visible;
    this.updateRuntimeSuspension();
  }

  private updateRuntimeSuspension(): void {
    const suspended = this.suspendWhenHidden && (!this.isVisible || !this.documentVisible);
    if (suspended === this.runtimeSuspended) {
      return;
    }
    this.runtimeSuspended = suspended;
    this.onRuntimeSuspensionChange(suspended);
  }

  /**
   * Suspension hook for subclasses that own an app execution vehicle (the
   * WASI worker / JSPI executor). The base runtime only presents frames, so
   * it has nothing to suspend.
   */
  protected onRuntimeSuspensionChange(
    _suspended: boolean
  ): void {}

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
    this.resizeSurface();
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
    // Into the mount, not only the console: a runtime issue is the app telling
    // the user something went wrong, and a console line is invisible to anyone
    // who is not already looking at devtools.
    this.writeOutput(`${issue.description}\n`);
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
    this.detachPointerParadigmObserver?.();
    this.resizeObserver?.disconnect();
    this.element.remove();
  }

  /**
   * Tells the app whether this client scrolls by dragging content directly.
   *
   * The app cannot see the browsing device, and one page bundle serves both a
   * phone and a desktop, so the paradigm has to be declared from here. It is
   * also not fixed for the session: a tablet can be docked to a mouse, so the
   * media query is watched and every real pointer press refines the answer
   * from `pointerType`. Only changes are sent.
   */
  private sendPointerCapabilitiesIfChanged(
    supportsScrollPanning: boolean
  ): void {
    if (this.lastSentPointerCapabilities === supportsScrollPanning) {
      return;
    }
    this.lastSentPointerCapabilities = supportsScrollPanning;
    this.bridge?.updatePointerCapabilities?.(supportsScrollPanning);
  }

  private installPointerParadigmObserver(): void {
    const query = coarsePointerQuery();
    if (!query?.addEventListener) {
      return;
    }

    const handleChange = (event: MediaQueryListEvent) => {
      this.sendPointerCapabilitiesIfChanged(event.matches);
    };
    query.addEventListener("change", handleChange);
    this.detachPointerParadigmObserver = () => {
      query.removeEventListener?.("change", handleChange);
    };
  }

  private presentSurface(
    frame: WebHostSurfaceFrame,
    recoveredImagePayloadIds?: readonly string[]
  ): void {
    const previousFrame = this.currentFrame;
    this.currentFrame = frame;
    this.columns = Math.max(1, Math.round(frame.width));
    this.rows = Math.max(1, Math.round(frame.height));
    const resized = this.resizeSurface();
    this.draw(
      previousFrame && !resized ? frame.damage : undefined,
      recoveredImagePayloadIds
    );
    this.syncAccessibilityTree();
  }

  /**
   * The current frame's preferred grid size in cells, when the app published
   * one — the measured pre-minimum content size, for embedders negotiating
   * with an outer layout system (the Android host's preferred columns/rows).
   */
  get preferredGridSize(): { width: number; height: number } | undefined {
    const frame = this.currentFrame;
    if (frame?.preferredGridWidth === undefined || frame.preferredGridHeight === undefined) {
      return undefined;
    }
    return { width: frame.preferredGridWidth, height: frame.preferredGridHeight };
  }

  /**
   * The current frame's settled focus presentation, when the app published
   * one. `prefersTextInput` is what the Android host uses to gate its IME;
   * embedders can drive virtual-keyboard or focus affordances from it.
   */
  get focusPresentation(): WebHostFocusPresentation | undefined {
    const presentation = this.currentFrame?.focusPresentation;
    if (!presentation) {
      return undefined;
    }
    return {
      ...presentation,
      semantics: normalizeSemantics(presentation.semantics),
    };
  }

  private linkTarget(
    location: CellLocation
  ): string | undefined {
    return linkTargetAt(
      this.currentFrame?.links,
      this.currentFrame?.linkTargets,
      location
    );
  }

  private openHyperlink(
    url: string
  ): void {
    if (this.onOpenHyperlink) {
      this.onOpenHyperlink(url);
      return;
    }
    // Defense in depth on top of the app-side OSC-8 destination sanitization:
    // the default handler only opens web schemes.
    if (!/^https?:/i.test(url)) {
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }

  private applyStyle(
    style: WebHostTerminalStyle
  ): void {
    applyWebHostTerminalStyle(this.element, style);
    this.element.style.boxSizing = "border-box";
    this.element.style.width = "80%";
    this.element.style.height = "80%";
    this.element.style.maxWidth = "100%";
    this.element.style.maxHeight = "100%";
    this.element.style.minWidth = "0";
    this.element.style.minHeight = "0";
    this.element.style.padding = "0.75rem";
    this.element.style.borderRadius = "16px";
    this.element.style.boxShadow = "0 20px 50px rgba(0, 0, 0, 0.28)";
    this.element.style.overflow = "hidden";
    this.element.style.resize = "both";
    this.element.style.flex = "0 0 auto";
    this.element.style.gap = "0.5rem";
    this.element.style.gridTemplateRows = "auto minmax(0, 1fr)";

    this.terminalMount.style.position = "relative";
    this.terminalMount.style.boxSizing = "border-box";
    this.terminalMount.style.width = "100%";
    this.terminalMount.style.height = "auto";
    this.terminalMount.style.minWidth = "0";
    this.terminalMount.style.minHeight = "0";
    this.terminalMount.style.alignSelf = "stretch";
    this.terminalMount.style.overflow = "hidden";
    // `contain` suppresses native ancestor scroll chaining even when the wheel
    // handler does not call preventDefault(). Only the explicit capture mode
    // wants that backstop. Chain/passive modes must leave the browser's default
    // scroll path open when handleWheel declines the event.
    this.terminalMount.style.overscrollBehavior =
      this.wheelMode === "capture" ? "contain" : "auto";
    this.terminalMount.style.outline = "none";
    this.terminalMount.style.background = webTUITerminalBackgroundColor(this.currentStyle);

    if (this.canvas) {
      this.canvas.style.display = "block";
      this.canvas.style.width = "100%";
      this.canvas.style.height = "100%";
    }
    if (this.domSurfaceRoot) {
      this.domSurfaceRoot.style.display = "block";
      this.domSurfaceRoot.style.position = "relative";
    }
  }

  /** The element the active painter presents frames into. */
  private get surfaceElement(): HTMLElement | undefined {
    return this.canvas ?? this.domSurfaceRoot;
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
      // A real press is better evidence than the media query: a hybrid device
      // reports its *primary* pointer there, but this is the pointer actually
      // being used. Refined before the press is forwarded so the app has the
      // paradigm by the time it decides what to do with the gesture.
      if (event.pointerType === "touch" || event.pointerType === "mouse") {
        this.sendPointerCapabilitiesIfChanged(event.pointerType === "touch");
      }
      if (this.allowsNativeTextSelection(event)) {
        // DOM renderer + Alt/Option: leave the event to the browser so the
        // drag becomes a native text selection instead of app pointer input.
        return;
      }
      const location = this.cellLocation(event);
      if (!location) {
        return;
      }

      const button = this.inputEncoder.pointerButton(event.button);
      this.activePointerButton = button;
      this.hasCapturedPointer = true;
      this.pointerDownLinkTarget = button === "primary"
        ? this.linkTarget(location)
        : undefined;
      this.terminalMount.focus?.({ preventScroll: true });
      this.terminalMount.setPointerCapture?.(event.pointerId);
      this.onInput(this.inputEncoder.encodePointerDown(location, button, event));
      event.preventDefault();
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (!this.hasCapturedPointer && this.allowsNativeTextSelection(event)) {
        return;
      }
      const location = this.hasCapturedPointer
        ? this.rawCellLocation(event)
        : this.cellLocation(event);
      this.terminalMount.releasePointerCapture?.(event.pointerId);
      this.hasCapturedPointer = false;
      const downLinkTarget = this.pointerDownLinkTarget;
      this.pointerDownLinkTarget = undefined;
      if (!location) {
        return;
      }

      const button = this.inputEncoder.pointerButton(event.button) ?? this.activePointerButton;
      this.onInput(this.inputEncoder.encodePointerUp(location, button, event));
      // A click — down and up over the same link target — opens the link,
      // mirroring the Android host's tap-to-open. The app still receives the
      // pointer messages above.
      if (downLinkTarget !== undefined && this.linkTarget(location) === downLinkTarget) {
        this.openHyperlink(downLinkTarget);
      }
      event.preventDefault();
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (!this.hasCapturedPointer && this.allowsNativeTextSelection(event)) {
        return;
      }
      const location = event.buttons && this.hasCapturedPointer
        ? this.rawCellLocation(event)
        : this.cellLocation(event);
      if (!location) {
        return;
      }

      if (!this.hasCapturedPointer) {
        this.terminalMount.style.cursor =
          this.linkTarget(location) !== undefined ? "pointer" : "";
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
    this.surfaceCSSWidth = width;
    this.surfaceCSSHeight = height;
    const nextColumns = Math.max(1, Math.floor(width / this.cellWidth));
    const nextRows = Math.max(1, Math.floor(height / this.cellHeight));

    this.columns = nextColumns;
    this.rows = nextRows;
    this.sendResizeIfNeeded();
    this.resizeSurface();
    // Changing a canvas's backing dimensions clears every pixel. Repaint the
    // retained frame synchronously so a CSS resize never leaves the terminal
    // blank while the app is producing its next frame for the new cell grid.
    this.draw();
    this.syncAccessibilityTree();
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

  private resizeSurface(): boolean {
    const gridCSSWidth = Math.max(1, this.columns * this.cellWidth);
    const gridCSSHeight = Math.max(1, this.rows * this.cellHeight);

    if (this.domSurfaceRoot) {
      const last = this.lastDomSurfaceSize;
      if (last && last.width === gridCSSWidth && last.height === gridCSSHeight) {
        return false;
      }
      this.lastDomSurfaceSize = { width: gridCSSWidth, height: gridCSSHeight };
      this.domSurfaceRoot.style.width = `${gridCSSWidth}px`;
      this.domSurfaceRoot.style.height = `${gridCSSHeight}px`;
      return true;
    }

    if (!this.canvas) {
      return false;
    }

    const scale = globalThis.window?.devicePixelRatio || 1;
    const cssWidth = Math.max(1, this.surfaceCSSWidth ?? gridCSSWidth);
    const cssHeight = Math.max(1, this.surfaceCSSHeight ?? gridCSSHeight);
    const width = Math.ceil(cssWidth * scale);
    const height = Math.ceil(cssHeight * scale);
    const styleWidth = "100%";
    const styleHeight = "100%";
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
    damage?: WebHostSurfaceDamage,
    recoveredImagePayloadIds?: readonly string[]
  ): void {
    this.painter.paint(
      this.surfaceMetrics(),
      this.currentFrame,
      damage,
      recoveredImagePayloadIds
    );
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
      rect: this.surfaceElement?.getBoundingClientRect?.() ?? this.terminalMount.getBoundingClientRect?.(),
      cellWidth: this.cellWidth,
      cellHeight: this.cellHeight,
      columns: this.columns,
      rows: this.rows,
    };
  }

  /**
   * Whether this pointer event should be left to the browser for native text
   * selection instead of being forwarded to the app. Only the DOM renderer
   * has real text nodes to select, and only while Alt/Option is held — plain
   * pointer input still belongs to the app.
   */
  private allowsNativeTextSelection(
    event: MouseEvent
  ): boolean {
    return this.rendererKind === "dom" && event.altKey;
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
