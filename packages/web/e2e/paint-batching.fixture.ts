import {
  BrowserWASIBridge,
  type WebHostPaintScheduling,
  type WebHostPaintStatistics,
  WebHostSceneRuntime,
  type WebHostSurfaceCell,
  type WebHostSurfaceFrame,
} from "../dist/index.js";

/**
 * Real-browser evidence for animation-frame paint batching (STUI-143): the
 * public runtime on the public WASI bridge, driven by a synthetic peer that
 * writes surface records straight into the bridge's stdout, painted by
 * Chrome's own `requestAnimationFrame`. The counterfactual is the same runtime
 * with `paintScheduling: "synchronous"`, i.e. the pre-batching behavior.
 */

export interface PaintBurstOptions {
  frameCount: number;
  scheduling: "default" | "synchronous";
  /** `"cell"`: each frame changes one cell with row-scoped damage; `"full"`: each frame redraws everything. */
  damage: "cell" | "full";
  width: number;
  height: number;
}

export interface PaintBurstResult {
  /** Paint-scheduler counters over the burst alone. */
  paints: number;
  presentedFrames: number;
  coalescedFrames: number;
  /**
   * Main-thread time to ingest the whole burst, in milliseconds. Under
   * synchronous scheduling this includes every paint; under batching the
   * paint runs later, in `paintMs`.
   */
  ingestMs: number;
  /** Time spent inside animation-frame paint callbacks after the burst. */
  paintMs: number;
  /** The canvas pixels once the burst has been painted. */
  pixels: number[];
  /** How many pixels changed from the keyframe: the burst must touch many. */
  changedPixels: number;
}

export interface PaintInputResult {
  /** Hyperlinks the runtime opened for clicks issued while a paint was pending. */
  openedBeforePaint: string[];
  /** Whether the canvas still showed the previous frame when the clicks were issued. */
  stalePixelsAtClick: boolean;
  /** Whether the canvas showed the new frame after the animation frame. */
  freshPixelsAfterPaint: boolean;
}

declare global {
  interface Window {
    runPaintBurst(options: PaintBurstOptions): Promise<PaintBurstResult>;
    runPaintInputJourney(): Promise<PaintInputResult>;
  }
}

const INPUT_GRID_WIDTH = 20;
const INPUT_GRID_HEIGHT = 6;
const STYLE = {
  fontSize: 16,
  fontFamily: "monospace",
  theme: { foreground: "#f8fafc", background: "#000000", tint: "#38bdf8" },
};

interface Scene {
  runtime: WebHostSceneRuntime;
  bridge: BrowserWASIBridge;
  canvas: HTMLCanvasElement;
  mount: HTMLElement;
  /** Milliseconds spent inside animation-frame paint callbacks so far. */
  readonly paintMs: number;
  present(
    frame: Omit<WebHostSurfaceFrame, "version" | "width" | "height" | "styles">,
  ): void;
  dispose(): void;
}

async function mountScene(options: {
  width: number;
  height: number;
  scheduling: "default" | "synchronous";
  onOpenHyperlink?: (url: string) => void;
}): Promise<Scene> {
  const mount = document.createElement("div");
  mount.style.width = "900px";
  mount.style.height = "600px";
  document.body.appendChild(mount);
  const bridge = new BrowserWASIBridge({
    sceneId: "paint-batching",
    columns: options.width,
    rows: options.height,
  });
  // The browser's own animation frames, with the time inside each paint callback recorded.
  let paintMs = 0;
  const timedAnimationFrames: WebHostPaintScheduling = {
    requestAnimationFrame: (callback) =>
      requestAnimationFrame((time) => {
        const start = performance.now();
        callback(time);
        paintMs += performance.now() - start;
      }),
    cancelAnimationFrame: (handle) => cancelAnimationFrame(handle),
  };
  const paintScheduling: WebHostPaintScheduling =
    options.scheduling === "synchronous" ? "synchronous" : timedAnimationFrames;
  const runtime = new WebHostSceneRuntime({
    mount,
    descriptor: {
      id: "paint-batching",
      title: "Paint batching",
      isDefault: true,
    },
    style: STYLE,
    bridge,
    onInput: (chunk) => bridge.sendInput(chunk),
    onOpenHyperlink: options.onOpenHyperlink,
    synchronizeAccessibilityFocus: false,
    paintScheduling,
  });
  await runtime.mount();
  runtime.setVisible(true);
  const canvas = runtime.terminalMount.querySelector("canvas");
  if (!canvas) {
    throw new Error("The canvas painter did not mount a canvas");
  }
  return {
    runtime,
    bridge,
    canvas,
    mount,
    get paintMs() {
      return paintMs;
    },
    present: (frame) => {
      bridge.stdout.write(
        `\u001Esurface:${JSON.stringify({
          version: 2,
          epoch: 1,
          width: options.width,
          height: options.height,
          styles: [null],
          ...frame,
        })}\n`,
      );
    },
    dispose: () => {
      runtime.dispose();
      mount.remove();
    },
  };
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function readPixels(canvas: HTMLCanvasElement): number[] {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("No 2D context");
  }
  return Array.from(
    context.getImageData(0, 0, canvas.width, canvas.height).data,
  );
}

function countDifferences(a: readonly number[], b: readonly number[]): number {
  let changed = 0;
  for (let index = 0; index < a.length; index += 4) {
    if (
      a[index] !== b[index] ||
      a[index + 1] !== b[index + 1] ||
      a[index + 2] !== b[index + 2] ||
      a[index + 3] !== b[index + 3]
    ) {
      changed += 1;
    }
  }
  return changed;
}

function filledRows(
  width: number,
  height: number,
  glyph: (x: number, y: number) => string,
): WebHostSurfaceCell[][] {
  return Array.from({ length: height }, (_, y) =>
    Array.from(
      { length: width },
      (_, x): WebHostSurfaceCell => [x, glyph(x, y), 1, 0],
    ),
  );
}

function deltaStatistics(
  after: WebHostPaintStatistics,
  before: WebHostPaintStatistics,
): Pick<
  WebHostPaintStatistics,
  "paints" | "presentedFrames" | "coalescedFrames"
> {
  return {
    paints: after.paints - before.paints,
    presentedFrames: after.presentedFrames - before.presentedFrames,
    coalescedFrames: after.coalescedFrames - before.coalescedFrames,
  };
}

/**
 * Publishes a keyframe of dots, then `frameCount - 1` frames in one task —
 * the shape of a burst the WASI worker hands the main thread. With `"cell"`
 * damage each frame turns one further cell into a letter under row-scoped
 * damage, so any cell the union of damage failed to cover would still show
 * its dot afterwards. With `"full"` damage each frame rewrites every cell and
 * carries no damage, the scroll-or-animation shape where every paint is a
 * full repaint.
 */
window.runPaintBurst = async (options) => {
  const { frameCount, width, height } = options;
  const scene = await mountScene(options);
  try {
    scene.present({ gen: 0, rows: filledRows(width, height, () => ".") });
    await nextAnimationFrame();
    await nextAnimationFrame();
    const keyframePixels = readPixels(scene.canvas);
    const before = scene.runtime.paintStatistics;
    const paintMsBefore = scene.paintMs;

    const rows = filledRows(width, height, () => ".");
    const start = performance.now();
    for (let index = 1; index < frameCount; index += 1) {
      if (options.damage === "cell") {
        const cell = (index - 1) % (width * height);
        const x = cell % width;
        const y = Math.floor(cell / width);
        rows[y]![x] = [x, String.fromCharCode(65 + (cell % 26)), 1, 0];
        scene.present({
          gen: index,
          rows: rows.map((row) => row.slice()),
          damage: {
            textRows: [[y, [[x, x + 1]]]],
            requiresFullTextRepaint: false,
            requiresFullGraphicsReplay: false,
          },
        });
      } else {
        scene.present({
          gen: index,
          rows: filledRows(width, height, (x, y) =>
            String.fromCharCode(65 + ((x + y + index) % 26)),
          ),
        });
      }
    }
    const ingestMs = performance.now() - start;

    await nextAnimationFrame();
    await nextAnimationFrame();
    const pixels = readPixels(scene.canvas);
    return {
      ...deltaStatistics(scene.runtime.paintStatistics, before),
      ingestMs,
      paintMs: scene.paintMs - paintMsBefore,
      pixels,
      changedPixels: countDifferences(pixels, keyframePixels),
    };
  } finally {
    scene.dispose();
  }
};

/**
 * The id of the engine's real mouse pointer, learned from the last genuine
 * pointer event on the page. Synthetic clicks must reuse it: the runtime
 * captures and releases the pointer by id, and an id that names no active
 * pointer throws `NotFoundError` (the mouse is pointer 1 in Chromium and
 * WebKit but 0 in Firefox).
 */
let realPointerId: number | undefined;
for (const type of ["pointermove", "pointerdown"] as const) {
  document.addEventListener(
    type,
    (event) => {
      if (event.isTrusted) {
        realPointerId = event.pointerId;
      }
    },
    { capture: true },
  );
}

/**
 * Presents a frame that moves a hyperlink from row 0 to row 1 and, before the
 * browser's next animation frame can paint it, clicks both rows with pointer
 * events dispatched inside the same task. The click must resolve against the
 * newest frame (where the app already is), while the pixels are allowed to
 * lag until the frame. The test moves the real mouse first so the engine's
 * pointer id is known.
 */
window.runPaintInputJourney = async () => {
  if (realPointerId === undefined) {
    throw new Error(
      "Move the real mouse over the page before running the input journey",
    );
  }
  const pointerId = realPointerId;
  const opened: string[] = [];
  const scene = await mountScene({
    width: INPUT_GRID_WIDTH,
    height: INPUT_GRID_HEIGHT,
    scheduling: "default",
    onOpenHyperlink: (url) => {
      opened.push(url);
    },
  });
  try {
    const rowOfLetters = (letter: string): WebHostSurfaceCell[] =>
      Array.from(
        { length: INPUT_GRID_WIDTH },
        (_, x): WebHostSurfaceCell => [x, letter, 1, 0],
      );
    scene.present({
      gen: 1,
      rows: [
        rowOfLetters("a"),
        rowOfLetters("."),
        ...Array.from({ length: INPUT_GRID_HEIGHT - 2 }, () => []),
      ],
      links: [[0, [[0, INPUT_GRID_WIDTH, 0]]]],
      linkTargets: ["https://example.test/row-0"],
    });
    await nextAnimationFrame();
    await nextAnimationFrame();
    const firstPixels = readPixels(scene.canvas);

    scene.present({
      gen: 2,
      rows: [
        rowOfLetters("."),
        rowOfLetters("b"),
        ...Array.from({ length: INPUT_GRID_HEIGHT - 2 }, () => []),
      ],
      links: [[1, [[0, INPUT_GRID_WIDTH, 0]]]],
      linkTargets: ["https://example.test/row-1"],
      damage: {
        textRows: [
          [0, []],
          [1, []],
        ],
        requiresFullTextRepaint: false,
        requiresFullGraphicsReplay: false,
      },
    });
    const stalePixelsAtClick =
      countDifferences(readPixels(scene.canvas), firstPixels) === 0;

    // Hit-testing is anchored at the surface element; a cell is the runtime's
    // measured row height (`fontSize * 1.35`, rounded up), not a share of the
    // canvas, which fills the whole mount.
    const rect = scene.canvas.getBoundingClientRect();
    const cellHeight = Math.ceil(STYLE.fontSize * 1.35);
    for (const row of [0, 1]) {
      const clientX = rect.left + 4;
      const clientY = rect.top + row * cellHeight + cellHeight / 2;
      for (const type of ["pointerdown", "pointerup"]) {
        scene.runtime.terminalMount.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            button: 0,
            buttons: type === "pointerdown" ? 1 : 0,
            clientX,
            clientY,
            pointerId,
            pointerType: "mouse",
          }),
        );
      }
    }
    const openedBeforePaint = [...opened];

    await nextAnimationFrame();
    await nextAnimationFrame();
    const freshPixelsAfterPaint =
      countDifferences(readPixels(scene.canvas), firstPixels) > 0;
    return { openedBeforePaint, stalePixelsAtClick, freshPixelsAfterPaint };
  } finally {
    scene.dispose();
  }
};
