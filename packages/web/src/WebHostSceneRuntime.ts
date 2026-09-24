import { AccessibilityTreeMounter } from "./AccessibilityTree.ts";
import {
  type CanvasSurfaceMetrics,
  CanvasSurfacePainter,
} from "./CanvasSurfacePainter.ts";
import {
  DOM_FONT_FAMILY,
  type DomFontOptions,
  DomFontResources,
  type DomFontResult,
} from "./DomFontResources.ts";
import {
  DomGeometryController,
  type DomGeometrySnapshot,
} from "./DomGeometry.ts";
import { DomSurfacePainter } from "./DomSurfacePainter.ts";
import {
  type CellLocation,
  InputEventEncoder,
  type PointerButton,
} from "./InputEventEncoder.ts";
import { normalizeSemantics } from "./normalizeWireTokens.ts";
import {
  cellLocationForEvent,
  linkTargetAt,
  type PointerGeometryMetrics,
  rawCellLocationForEvent,
  wheelTargetCanScroll,
} from "./PointerGeometry.ts";
import { boundedCanvasSize } from "./RasterAllocationBudget.ts";
import {
  defaultAnimationFrameScheduler,
  type SurfacePaintRequest,
  SurfacePaintScheduler,
  type WebHostPaintScheduling,
  type WebHostPaintStatistics,
} from "./SurfacePaintScheduler.ts";
import type { WebHostSurfaceRendererKind } from "./SurfaceRenderer.ts";
import { fontForStyle } from "./SurfaceTypography.ts";
import type { WebHostSceneDescriptor } from "./WebHostSceneManifest.ts";
import type {
  WebHostAccessibilityAnnouncement,
  WebHostFocusPresentation,
  WebHostFrameDiagnosticRecord,
  WebHostImagePayloadRequestHandler,
  WebHostOutputSink,
  WebHostRuntimeIssue,
  WebHostSurfaceFrame,
} from "./WebHostSurfaceTransport.ts";
import { encodeAccessibilityActionMessage } from "./WebHostSurfaceTransport.ts";
import {
  applyWebHostTerminalStyle,
  normalizeWebHostTerminalStyle,
  type ResolvedWebHostTerminalStyle,
  type WebHostTerminalStyle,
  webTUITerminalBackgroundColor,
} from "./WebHostTerminalStyle.ts";

export interface WebHostSceneBridge {
  bindOutput(sink: WebHostOutputSink): void;
  resize(
    columns: number,
    rows: number,
    cellWidth?: number,
    cellHeight?: number,
  ): void;
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
  domFont?: DomFontOptions;
  /**
   * How the scene element occupies the mount. `"fill"` (default) stretches
   * to 100% of the mount in both directions with no resize handle;
   * `"resizable"` is the standalone page's user-resizable frame. See
   * {@link WebHostSceneFrameMode}.
   */
  sceneFrame?: WebHostSceneFrameMode;
  /**
   * How visual paints are scheduled. By default the runtime paints through the
   * global `requestAnimationFrame`, coalescing every surface frame received
   * within one animation frame into a single paint (see
   * {@link WebHostSceneRuntime} for what advances when). Pass an
   * {@link WebHostAnimationFrameScheduler} to supply the animation-frame pair
   * (tests tick one by hand), or `"synchronous"` to paint each frame as it is
   * received. Where the host has no `requestAnimationFrame`, paints are
   * synchronous regardless.
   */
  paintScheduling?: WebHostPaintScheduling;
}

export type WheelMode = "capture" | "chain" | "passive";

/**
 * How the scene element occupies its mount.
 * - `"fill"` (default): the scene stretches to 100% of the mount in both
 *   directions with no user-resize affordance — the embedding contract, where
 *   the host page owns sizing and the scene follows its container.
 * - `"resizable"`: the standalone WebHost page's frame — a user-resizable
 *   card (`resize: both`) that starts at 80% of the mount, capped at 100%.
 *   The packaged local-server page (`browser.ts`) opts into this; embedders
 *   normally should not.
 */
export type WebHostSceneFrameMode = "fill" | "resizable";

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
 *
 * ## What advances when a frame arrives
 *
 * Surface frames are decoded and applied in transport order, but the visible
 * paint is batched: all frames received within one animation frame are painted
 * once, as the newest frame (see {@link SurfacePaintScheduler}). Two clocks
 * therefore exist, and each piece of state follows one of them deliberately:
 *
 * - **Immediately, on receipt:** pointer geometry (link targets under the
 *   pointer, wheel-chaining scroll regions, the cell grid used for
 *   hit-testing), `preferredGridSize`, and `focusPresentation`. Input is
 *   routed to an app that has already moved to the newest frame, so resolving
 *   a click or wheel against an older, still-visible frame would disagree with
 *   what the app does with that input.
 * - **With the visible frame, at the next animation frame:** the painted
 *   surface and the ARIA sidecar (tree, focus, live regions). Assistive
 *   technology then always describes exactly what is on screen, and DOM
 *   mutation for the tree is coalesced with the paint. Imperative
 *   announcements from every coalesced frame are delivered, in order, with that
 *   paint; only live-region *label* changes collapse to their final value, as
 *   they would for any rapid update.
 *
 * Clipboard writes, runtime issues, frame diagnostics, and text output are
 * not visual and stay synchronous and ordered. Resizes, restyles, and a
 * document becoming visible again paint synchronously and fully.
 */
export class WebHostSceneRuntime {
  readonly descriptor: WebHostSceneDescriptor;
  readonly element: HTMLElement;
  readonly terminalMount: HTMLElement;

  private readonly bridge?: WebHostSceneBridge;
  private readonly onInput: (chunk: Uint8Array) => void;
  private readonly onFrameDiagnostic?: (
    diagnostic: WebHostFrameDiagnosticRecord,
  ) => void;
  private readonly synchronizeAccessibilityFocus: boolean;
  private readonly wheelMode: WheelMode;
  private readonly rendererKind: WebHostSurfaceRendererKind;
  private readonly sceneFrame: WebHostSceneFrameMode;
  private readonly painter: CanvasSurfacePainter | DomSurfacePainter;
  private readonly paintScheduler: SurfacePaintScheduler;
  private readonly inputEncoder = new InputEventEncoder();
  private currentStyle: ResolvedWebHostTerminalStyle;
  private canvas?: HTMLCanvasElement;
  private canvasScale = 1;
  private domSurfaceRoot?: HTMLElement;
  private lastDomSurfaceSize?: { width: number; height: number };
  private domGeometry?: DomGeometryController;
  private readonly embeddingMount: HTMLElement;
  private geometryRefreshHandle?: number;
  private geometryDiagnostic?: string;
  private disposed = false;
  private readonly domFontOptions?: DomFontOptions;
  private fontResources?: DomFontResources;
  private activeFontResources?: DomFontResources;
  private fontPending = false;
  private fontResult?: DomFontResult;
  private loadingFont?: HTMLElement;
  private accessibilityTree?: AccessibilityTreeMounter;
  private diagnosticText?: HTMLElement;
  private resizeObserver?: ResizeObserver;
  private detachMetricObservers?: () => void;
  private nativePointerGesture = false;
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
    this.embeddingMount = options.mount;
    this.currentStyle = normalizeWebHostTerminalStyle(
      options.renderer === "dom" && !options.style.fontFamily
        ? { ...options.style, fontFamily: DOM_FONT_FAMILY }
        : options.style,
    );
    this.domFontOptions = options.domFont;
    this.bridge = options.bridge;
    this.onInput = options.onInput;
    this.onFrameDiagnostic = options.onFrameDiagnostic;
    this.synchronizeAccessibilityFocus =
      options.synchronizeAccessibilityFocus ?? true;
    this.wheelMode =
      options.wheelMode ?? legacyWheelMode(options.captureWheelInput);
    this.rendererKind = options.renderer ?? "canvas";
    this.sceneFrame = options.sceneFrame ?? "fill";
    const onImagePayloadMiss = (
      ids: readonly string[],
    ): readonly string[] | void => {
      return this.bridge?.requestImagePayloads?.(ids);
    };
    this.painter =
      this.rendererKind === "dom"
        ? new DomSurfacePainter({
            onImagePayloadMiss,
            onOpenHyperlink: options.onOpenHyperlink,
          })
        : new CanvasSurfacePainter({ onImagePayloadMiss });
    const paintScheduling =
      options.paintScheduling ?? defaultAnimationFrameScheduler();
    this.paintScheduler = new SurfacePaintScheduler(
      paintScheduling === "synchronous" ? undefined : paintScheduling,
      (request) => this.paint(request),
    );
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
      surfaceRoot.className =
        "webhost-scene__surface webhost-scene__surface--dom";
      surfaceRoot.setAttribute("aria-hidden", "true");
      this.domSurfaceRoot = surfaceRoot;
      this.painter.attach(surfaceRoot);
    } else {
      const canvas = document.createElement("canvas");
      canvas.className = "webhost-scene__surface";
      canvas.setAttribute("aria-hidden", "true");
      this.canvas = canvas;
      // A decode completion asks for a repaint; many completing at once fold
      // into the next animation frame rather than each painting the surface.
      this.painter.attach(canvas, () => this.paintScheduler.requestRepaint());
    }
    this.accessibilityTree = new AccessibilityTreeMounter(
      (target, request, requestID) => {
        this.onInput(
          encodeAccessibilityActionMessage(target, request, requestID),
        );
      },
    );
    this.terminalMount.replaceChildren(
      this.surfaceElement as HTMLElement,
      this.accessibilityTree.element,
      this.accessibilityTree.announcerElement,
    );
    if (this.domSurfaceRoot) {
      this.domGeometry = new DomGeometryController(this.terminalMount);
      this.paintScheduler.setHeld(true);
    }
    this.installInputHandlers();
    this.installResizeObserver();

    this.bridge?.bindOutput({
      presentSurface: (frame, recoveredImagePayloadIds) =>
        this.presentSurface(frame, recoveredImagePayloadIds),
      writeClipboard: (text) => this.writeClipboard(text),
      notifyRuntimeIssue: (issue) => this.notifyRuntimeIssue(issue),
      recordFrameDiagnostic: (diagnostic) =>
        this.recordFrameDiagnostic(diagnostic),
      writeOutput: (text) => this.writeOutput(text),
      writeError: (text) => this.writeOutput(text),
    });

    this.applyStyle(this.currentStyle);
    if (this.domGeometry) this.loadDomFont(this.currentStyle);
    this.installPointerParadigmObserver();
    this.sendPointerCapabilitiesIfChanged(coarsePrimaryPointer());
    this.measureCells();
    this.resizeToMount();
  }

  setVisible(visible: boolean): void {
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
  setDocumentVisible(visible: boolean): void {
    const becameVisible = visible && !this.documentVisible;
    this.documentVisible = visible;
    this.updateRuntimeSuspension();
    // Browsers pause animation frames while the document is hidden, so frames
    // that arrived meanwhile are still waiting. Paint them fully and now rather
    // than at whatever moment the browser resumes the callback: the backing
    // store may have been discarded while hidden, and the paint must not
    // depend on a timing the page cannot observe.
    if (becameVisible && this.paintScheduler.statistics.pending) {
      this.paintScheduler.repaintNow();
    }
  }

  /** Paint-scheduler counters: frames presented, paints delivered, frames coalesced. */
  get paintStatistics(): WebHostPaintStatistics {
    return this.paintScheduler.statistics;
  }

  private updateRuntimeSuspension(): void {
    const suspended =
      this.suspendWhenHidden && (!this.isVisible || !this.documentVisible);
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
  protected onRuntimeSuspensionChange(_suspended: boolean): void {}

  setStyle(style: WebHostTerminalStyle): void {
    const next = normalizeWebHostTerminalStyle(
      this.domGeometry && !style.fontFamily
        ? { ...style, fontFamily: DOM_FONT_FAMILY }
        : style,
    );
    if (this.domGeometry) {
      this.loadDomFont(next);
      return;
    }
    this.currentStyle = next;
    this.applyStyle(this.currentStyle);
    this.bridge?.updateRenderStyle(this.currentStyle);
    this.measureCells();
    this.resizeToMount();
  }

  resize(columns: number, rows: number): void {
    this.columns = Math.max(1, Math.round(columns));
    this.rows = Math.max(1, Math.round(rows));
    this.paintScheduler.repaintNow();
  }

  writeOutput(text: string): void {
    if (!this.diagnosticText) {
      const diagnosticText = document.createElement("pre");
      diagnosticText.className = "webhost-scene__diagnostic";
      if (this.rendererKind === "dom") {
        diagnosticText.setAttribute("role", "status");
        Object.assign(diagnosticText.style, {
          position: "absolute",
          inset: "auto 0 0",
          zIndex: "5",
          boxSizing: "border-box",
          margin: "0",
          padding: "8px",
          maxHeight: "50%",
          overflow: "auto",
          whiteSpace: "pre-wrap",
          font: "12px/1.4 system-ui, sans-serif",
          color: "#fff",
          background: "#402020",
        });
      }
      this.diagnosticText = diagnosticText;
      this.terminalMount.appendChild(diagnosticText);
    }
    this.diagnosticText.textContent =
      `${this.diagnosticText.textContent ?? ""}${text}`.slice(-16384);
  }

  notifyRuntimeIssue(issue: WebHostRuntimeIssue): void {
    // Into the mount, not only the console: a runtime issue is the app telling
    // the user something went wrong, and a console line is invisible to anyone
    // who is not already looking at devtools.
    this.writeOutput(`${issue.description}\n`);
  }

  private recordFrameDiagnostic(
    diagnostic: WebHostFrameDiagnosticRecord,
  ): void {
    this.onFrameDiagnostic?.(diagnostic);
  }

  async writeClipboard(text: string): Promise<void> {
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

  sendInput(chunk: Uint8Array): void {
    this.onInput(chunk);
  }

  dispose(): void {
    // Before the painter: a paint scheduled for the next animation frame must
    // never run against a disposed painter or a removed mount.
    this.disposed = true;
    this.fontResources?.dispose();
    if (this.activeFontResources !== this.fontResources)
      this.activeFontResources?.dispose();
    if (this.geometryRefreshHandle !== undefined)
      globalThis.cancelAnimationFrame?.(this.geometryRefreshHandle);
    this.domGeometry?.dispose();
    this.paintScheduler.dispose();
    this.painter.dispose();
    this.detachInputHandlers?.();
    this.detachPointerParadigmObserver?.();
    this.resizeObserver?.disconnect();
    this.detachMetricObservers?.();
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
    supportsScrollPanning: boolean,
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

  /**
   * Receives one decoded frame in transport order. The frame becomes current
   * at once — pointer geometry, `preferredGridSize`, and `focusPresentation`
   * read it from here on — while the paint and the ARIA sidecar wait for the
   * scheduler's next animation frame (or happen now, under synchronous
   * scheduling). The surface's backing size is adjusted inside that paint, so
   * a resize never clears the canvas ahead of the frame that fills it.
   */
  private presentSurface(
    frame: WebHostSurfaceFrame,
    recoveredImagePayloadIds?: readonly string[],
  ): void {
    this.currentFrame = frame;
    this.columns = Math.max(1, Math.round(frame.width));
    this.rows = Math.max(1, Math.round(frame.height));
    this.paintScheduler.present(frame, recoveredImagePayloadIds);
  }

  /**
   * The current frame's preferred grid size in cells, when the app published
   * one — the measured pre-minimum content size, for embedders negotiating
   * with an outer layout system (the Android host's preferred columns/rows).
   */
  get preferredGridSize(): { width: number; height: number } | undefined {
    const frame = this.currentFrame;
    if (
      frame?.preferredGridWidth === undefined ||
      frame.preferredGridHeight === undefined
    ) {
      return undefined;
    }
    return {
      width: frame.preferredGridWidth,
      height: frame.preferredGridHeight,
    };
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

  private linkTarget(location: CellLocation): string | undefined {
    return linkTargetAt(
      this.currentFrame?.links,
      this.currentFrame?.linkTargets,
      location,
    );
  }

  private openHyperlink(url: string): void {
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

  private applyStyle(style: WebHostTerminalStyle): void {
    applyWebHostTerminalStyle(this.element, style);
    this.element.style.boxSizing = "border-box";
    // The resizable frame geometry is standalone-page chrome. Embedders keep
    // the fill contract: the scene follows its container, and only the host
    // page decides its size.
    if (this.sceneFrame === "resizable") {
      this.element.style.width = "80%";
      this.element.style.height = "80%";
      this.element.style.maxWidth = "100%";
      this.element.style.maxHeight = "100%";
      this.element.style.resize = "both";
      this.element.style.flex = "0 0 auto";
    } else {
      this.element.style.width = "100%";
      this.element.style.height = "100%";
    }
    this.element.style.minWidth = "0";
    this.element.style.minHeight = "0";
    this.element.style.padding = "0.75rem";
    this.element.style.borderRadius = "16px";
    this.element.style.boxShadow = "0 20px 50px rgba(0, 0, 0, 0.28)";
    this.element.style.overflow = "hidden";
    this.element.style.gap = "0.5rem";
    this.element.style.gridTemplateRows = "auto minmax(0, 1fr)";

    this.terminalMount.style.position = "relative";
    // Keep the terminal in the flexible track when page chrome hides the
    // header. Auto-placement into the first, intrinsic track can collapse an
    // initially empty DOM surface before its first geometry request.
    this.terminalMount.style.gridRow = "2";
    this.terminalMount.style.boxSizing = "border-box";
    this.terminalMount.style.width = "100%";
    if (this.sceneFrame === "resizable") {
      this.terminalMount.style.height = "auto";
      this.terminalMount.style.alignSelf = "stretch";
    } else {
      this.terminalMount.style.height = "100%";
    }
    this.terminalMount.style.minWidth = "0";
    this.terminalMount.style.minHeight = "0";
    this.terminalMount.style.overflow = "hidden";
    // `contain` suppresses native ancestor scroll chaining even when the wheel
    // handler does not call preventDefault(). Only the explicit capture mode
    // wants that backstop. Chain/passive modes must leave the browser's default
    // scroll path open when handleWheel declines the event.
    this.terminalMount.style.overscrollBehavior =
      this.wheelMode === "capture" ? "contain" : "auto";
    this.terminalMount.style.outline = "none";
    this.terminalMount.style.background = webTUITerminalBackgroundColor(
      this.currentStyle,
    );

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
      "important",
    );
  }

  private installResizeObserver(): void {
    const refresh = () => {
      if (this.domGeometry) {
        this.refreshGeometry();
        return;
      }
      if (this.painter instanceof DomSurfacePainter)
        this.painter.invalidateFontMetrics();
      this.resizeToMount();
    };
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(refresh);
      this.resizeObserver.observe(this.terminalMount);
      if (this.domGeometry) this.resizeObserver.observe(this.embeddingMount);
      if (this.domGeometry)
        this.resizeObserver.observe(this.domGeometry.probe.element);
    }
    const fonts = document.fonts;
    fonts?.addEventListener?.("loadingdone", refresh);
    fonts?.addEventListener?.("loadingerror", refresh);
    globalThis.window?.addEventListener?.("resize", refresh);
    globalThis.window?.visualViewport?.addEventListener("resize", refresh);
    let dpr: MediaQueryList | undefined;
    const watchDpr = () => {
      dpr?.removeEventListener?.("change", changedDpr);
      dpr = globalThis.matchMedia?.(
        `(resolution: ${globalThis.devicePixelRatio || 1}dppx)`,
      );
      dpr?.addEventListener?.("change", changedDpr);
    };
    const changedDpr = () => {
      watchDpr();
      refresh();
    };
    watchDpr();
    this.detachMetricObservers = () => {
      fonts?.removeEventListener?.("loadingdone", refresh);
      fonts?.removeEventListener?.("loadingerror", refresh);
      globalThis.window?.removeEventListener?.("resize", refresh);
      globalThis.window?.visualViewport?.removeEventListener("resize", refresh);
      dpr?.removeEventListener?.("change", changedDpr);
    };
  }

  private installInputHandlers(): void {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.metaKey ||
        event.isComposing ||
        (this.rendererKind === "dom" &&
          event.ctrlKey &&
          (event.key.toLowerCase() === "f" ||
            (event.key.toLowerCase() === "c" &&
              document.getSelection?.()?.isCollapsed === false)))
      ) {
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
      if (this.allowsNativeTextSelection(event) || this.isNativeLink(event)) {
        this.nativePointerGesture = true;
        // DOM renderer + Alt/Option: leave the event to the browser so the
        // drag becomes a native text selection instead of app pointer input.
        return;
      }
      const location = this.cellLocation(event);
      if (!location) {
        return;
      }

      this.nativePointerGesture = false;
      const button = this.inputEncoder.pointerButton(event.button);
      this.activePointerButton = button;
      this.hasCapturedPointer = true;
      this.pointerDownLinkTarget =
        button === "primary" ? this.linkTarget(location) : undefined;
      this.terminalMount.focus?.({ preventScroll: true });
      this.terminalMount.setPointerCapture?.(event.pointerId);
      this.onInput(
        this.inputEncoder.encodePointerDown(location, button, event),
      );
      event.preventDefault();
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (
        !this.hasCapturedPointer &&
        (this.nativePointerGesture ||
          this.allowsNativeTextSelection(event) ||
          this.isNativeLink(event))
      ) {
        this.nativePointerGesture = false;
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

      const button =
        this.inputEncoder.pointerButton(event.button) ??
        this.activePointerButton;
      this.onInput(this.inputEncoder.encodePointerUp(location, button, event));
      // A click — down and up over the same link target — opens the link,
      // mirroring the Android host's tap-to-open. The app still receives the
      // pointer messages above.
      if (
        downLinkTarget !== undefined &&
        this.linkTarget(location) === downLinkTarget
      ) {
        this.openHyperlink(downLinkTarget);
      }
      event.preventDefault();
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (
        !this.hasCapturedPointer &&
        (this.nativePointerGesture ||
          this.allowsNativeTextSelection(event) ||
          this.isNativeLink(event))
      ) {
        return;
      }
      const location =
        event.buttons && this.hasCapturedPointer
          ? this.rawCellLocation(event)
          : this.cellLocation(event);
      if (!location) {
        return;
      }

      if (!this.hasCapturedPointer) {
        this.terminalMount.style.cursor =
          this.linkTarget(location) !== undefined ? "pointer" : "";
      }
      this.onInput(
        this.inputEncoder.encodePointerMove(
          location,
          this.activePointerButton,
          event,
        ),
      );
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
      if (
        this.wheelMode === "chain" &&
        !wheelTargetCanScroll(
          this.currentFrame?.scrollRegions,
          location,
          event.deltaX,
          event.deltaY,
        )
      ) {
        return;
      }

      this.onInput(this.inputEncoder.encodeWheel(location, event));
      event.preventDefault();
    };

    const endNativeDrag = () => {
      this.nativePointerGesture = false;
    };
    document.addEventListener?.("pointerup", endNativeDrag);
    document.addEventListener?.("pointercancel", endNativeDrag);
    this.terminalMount.addEventListener("keydown", handleKeyDown);
    this.terminalMount.addEventListener("paste", handlePaste);
    this.terminalMount.addEventListener("pointerdown", handlePointerDown);
    this.terminalMount.addEventListener("pointerup", handlePointerUp);
    this.terminalMount.addEventListener("pointermove", handlePointerMove);
    this.terminalMount.addEventListener("wheel", handleWheel, {
      passive: false,
    });

    this.detachInputHandlers = () => {
      document.removeEventListener?.("pointerup", endNativeDrag);
      document.removeEventListener?.("pointercancel", endNativeDrag);
      this.terminalMount.removeEventListener("keydown", handleKeyDown);
      this.terminalMount.removeEventListener("paste", handlePaste);
      this.terminalMount.removeEventListener("pointerdown", handlePointerDown);
      this.terminalMount.removeEventListener("pointerup", handlePointerUp);
      this.terminalMount.removeEventListener("pointermove", handlePointerMove);
      this.terminalMount.removeEventListener("wheel", handleWheel);
    };
  }

  private resizeToMount(): void {
    if (this.disposed) return;
    if (this.fontPending) return;
    if (this.domGeometry) {
      let snapshot: DomGeometrySnapshot | undefined;
      try {
        snapshot = this.domGeometry.measure(this.currentStyle);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message !== this.geometryDiagnostic)
          this.writeOutput(`${message}\n`);
        this.geometryDiagnostic = message;
      }
      if (!snapshot) {
        this.paintScheduler.setHeld(true);
        return;
      }
      this.cellWidth = snapshot.cellWidth;
      this.cellHeight = snapshot.cellHeight;
      this.columns = snapshot.columns;
      this.rows = snapshot.rows;
      this.surfaceCSSWidth = snapshot.content.width;
      this.surfaceCSSHeight = snapshot.content.height;
      if (snapshot.bounded && this.geometryDiagnostic !== "bounded") {
        this.writeOutput(
          "DOM viewport exceeds the supported grid; showing a bounded viewport.\n",
        );
        this.geometryDiagnostic = "bounded";
      } else if (!snapshot.bounded) this.geometryDiagnostic = undefined;
      this.sendResizeIfNeeded();
      this.paintScheduler.setHeld(false);
      this.paintScheduler.repaintNow();
      return;
    }
    this.measureCells();
    const rect = this.terminalMount.getBoundingClientRect?.();
    const width =
      this.terminalMount.clientWidth ||
      (rect?.width && rect.width > 0
        ? rect.width
        : this.columns * this.cellWidth);
    const height =
      this.terminalMount.clientHeight ||
      (rect?.height && rect.height > 0
        ? rect.height
        : this.rows * this.cellHeight);
    this.surfaceCSSWidth = width;
    this.surfaceCSSHeight = height;
    const nextColumns = Math.max(1, Math.floor(width / this.cellWidth));
    const nextRows = Math.max(1, Math.floor(height / this.cellHeight));

    this.columns = nextColumns;
    this.rows = nextRows;
    this.sendResizeIfNeeded();
    // Changing a canvas's backing dimensions clears every pixel. Repaint the
    // retained frame synchronously so a CSS resize never leaves the terminal
    // blank while the app is producing its next frame for the new cell grid.
    this.paintScheduler.repaintNow();
  }

  private sendResizeIfNeeded(): void {
    const current = {
      columns: this.columns,
      rows: this.rows,
      cellWidth: this.cellWidth,
      cellHeight: this.cellHeight,
    };
    if (
      this.lastSentResize &&
      this.lastSentResize.columns === current.columns &&
      this.lastSentResize.rows === current.rows &&
      this.lastSentResize.cellWidth === current.cellWidth &&
      this.lastSentResize.cellHeight === current.cellHeight
    ) {
      return;
    }

    this.lastSentResize = current;
    this.bridge?.resize(
      current.columns,
      current.rows,
      current.cellWidth,
      current.cellHeight,
    );
  }

  private resizeSurface(): boolean {
    const gridCSSWidth = Math.max(1, this.columns * this.cellWidth);
    const gridCSSHeight = Math.max(1, this.rows * this.cellHeight);

    if (this.domSurfaceRoot) {
      const last = this.lastDomSurfaceSize;
      if (
        last &&
        last.width === gridCSSWidth &&
        last.height === gridCSSHeight
      ) {
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
    const bounded = boundedCanvasSize(cssWidth, cssHeight, scale);
    const { width, height } = bounded;
    const scaleChanged = this.canvasScale !== bounded.scale;
    this.canvasScale = bounded.scale;
    const styleWidth = "100%";
    const styleHeight = "100%";
    if (
      this.canvas.width === width &&
      this.canvas.height === height &&
      this.canvas.style.width === styleWidth &&
      this.canvas.style.height === styleHeight &&
      !scaleChanged
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
    if (this.domSurfaceRoot) {
      return; // DOM geometry is measured by its controller; never request Canvas.
    }
    const canvas = this.canvas ?? document.createElement("canvas");
    const context = canvas.getContext?.("2d");
    if (!context) {
      this.cellWidth = Math.max(
        1,
        Math.round(this.currentStyle.fontSize * 0.62),
      );
      this.cellHeight = Math.max(
        1,
        Math.round(this.currentStyle.fontSize * 1.35),
      );
      return;
    }

    context.font = fontForStyle(this.currentStyle);
    this.cellWidth = Math.max(1, Math.ceil(context.measureText("W").width));
    this.cellHeight = Math.max(1, Math.ceil(this.currentStyle.fontSize * 1.35));
  }

  /**
   * The one place pixels and the ARIA sidecar change, called by the paint
   * scheduler with the newest frame and everything coalesced into it.
   */
  private paint(request: SurfacePaintRequest): void {
    if (this.domGeometry?.pending) {
      const pending = this.domGeometry.pending;
      const snapshot = Object.freeze({
        ...pending,
        columns: request.frame?.width ?? pending.columns,
        rows: request.frame?.height ?? pending.rows,
      });
      this.domGeometry.present(snapshot);
      this.cellWidth = snapshot.cellWidth;
      this.cellHeight = snapshot.cellHeight;
      this.columns = Math.max(1, snapshot.columns);
      this.rows = Math.max(1, snapshot.rows);
      if (this.accessibilityTree) {
        Object.assign(this.accessibilityTree.element.style, {
          inset: "auto",
          left: `${snapshot.content.offsetX}px`,
          top: `${snapshot.content.offsetY}px`,
          width: `${this.columns * snapshot.cellWidth}px`,
          height: `${this.rows * snapshot.cellHeight}px`,
        });
      }
    }
    // Sizing the backing store clears it, so it happens here, immediately
    // before the frame that fills it — never on receipt of a deferred frame.
    const resized = this.resizeSurface();
    this.painter.paint(
      this.surfaceMetrics(),
      request.frame,
      resized ? undefined : request.damage,
      request.recoveredImagePayloadIds,
    );
    this.syncAccessibilityTree(
      request.frame,
      request.accessibilityAnnouncements,
    );
  }

  private syncAccessibilityTree(
    frame: WebHostSurfaceFrame | undefined,
    announcements: readonly WebHostAccessibilityAnnouncement[],
  ): void {
    const tree = this.accessibilityTree;
    if (!tree || !frame) {
      return;
    }

    tree.present(
      frame.accessibilityTree ?? [],
      {
        cellWidth: this.cellWidth,
        cellHeight: this.cellHeight,
      },
      [...announcements],
      {
        synchronizeFocus: this.synchronizeAccessibilityFocus,
        actionResponse: frame.accessibilityActionResponse,
      },
    );
  }

  private surfaceMetrics(): CanvasSurfaceMetrics {
    return {
      columns: this.columns,
      rows: this.rows,
      cellWidth: this.cellWidth,
      cellHeight: this.cellHeight,
      pixelScale: this.canvasScale,
      style: this.currentStyle,
    };
  }

  private pointerMetrics(): PointerGeometryMetrics {
    const domRect = this.domSurfaceRoot?.getBoundingClientRect?.();
    const presented = this.domGeometry?.presented;
    const columns = presented?.columns ?? this.columns;
    const rows = presented?.rows ?? this.rows;
    return {
      rect:
        this.surfaceElement?.getBoundingClientRect?.() ??
        this.terminalMount.getBoundingClientRect?.(),
      cellWidth: domRect?.width ? domRect.width / columns : this.cellWidth,
      cellHeight: domRect?.height ? domRect.height / rows : this.cellHeight,
      columns,
      rows,
    };
  }

  /** Remeasure after embedding CSS changes; invalidations coalesce in one animation frame. */
  refreshGeometry(): void {
    if (this.disposed || this.geometryRefreshHandle !== undefined) return;
    if (!globalThis.requestAnimationFrame) {
      this.resizeToMount();
      return;
    }
    this.geometryRefreshHandle = requestAnimationFrame(() => {
      this.geometryRefreshHandle = undefined;
      this.resizeToMount();
    });
  }

  get geometrySnapshot(): DomGeometrySnapshot | undefined {
    return this.domGeometry?.presented;
  }

  get fontStatus(): DomFontResult | undefined {
    return this.fontResult;
  }
  get fontReady(): Promise<DomFontResult> | undefined {
    return this.fontResources?.ready;
  }

  private loadDomFont(style: ResolvedWebHostTerminalStyle): void {
    if (this.fontResources !== this.activeFontResources)
      this.fontResources?.dispose();
    this.fontPending = true;
    this.paintScheduler.setHeld(true);
    this.terminalMount.setAttribute("aria-busy", "true");
    if (!this.loadingFont) {
      this.loadingFont = document.createElement("div");
      this.loadingFont.setAttribute("role", "status");
      this.loadingFont.textContent = "Loading display font…";
      this.terminalMount.appendChild(this.loadingFont);
    }
    const resources = new DomFontResources(
      this.terminalMount.ownerDocument ?? document,
      style.fontFamily,
      style.fontSize,
      this.domFontOptions,
    );
    this.fontResources = resources;
    void resources.ready
      .then((result) => {
        if (
          this.disposed ||
          resources !== this.fontResources ||
          result.status === "disposed"
        )
          return;
        this.fontResult = result;
        const previousResources = this.activeFontResources;
        this.activeFontResources = resources;
        this.fontPending = false;
        this.loadingFont?.remove();
        this.loadingFont = undefined;
        this.terminalMount.removeAttribute("aria-busy");
        this.currentStyle = { ...style, fontFamily: result.family };
        this.applyStyle(this.currentStyle);
        this.bridge?.updateRenderStyle(this.currentStyle);
        if (result.diagnostic) this.writeOutput(`${result.diagnostic}\n`);
        this.resizeToMount();
        previousResources?.dispose();
      })
      .catch((error) => {
        if (this.disposed || resources !== this.fontResources) return;
        this.fontPending = false;
        this.writeOutput(`DOM font configuration failed: ${String(error)}\n`);
      });
  }

  /**
   * Whether this pointer event should be left to the browser for native text
   * selection instead of being forwarded to the app. Only the DOM renderer
   * has real text nodes to select, and only while Alt/Option is held — plain
   * pointer input still belongs to the app.
   */
  private isNativeLink(event: MouseEvent): boolean {
    return (
      this.rendererKind === "dom" &&
      !!(event.target as Element | null)?.closest?.("a[data-surface-link]")
    );
  }

  private allowsNativeTextSelection(event: MouseEvent): boolean {
    return this.rendererKind === "dom" && event.altKey;
  }

  private cellLocation(event: MouseEvent): CellLocation | undefined {
    return cellLocationForEvent(event, this.pointerMetrics());
  }

  private rawCellLocation(event: MouseEvent): CellLocation | undefined {
    return rawCellLocationForEvent(event, this.pointerMetrics());
  }
}
