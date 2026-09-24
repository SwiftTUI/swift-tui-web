/** Released bytes copied by @swifttui/build; no external font service. */
export const DOM_FONT_FAMILY = "SwiftTUI Source Code Pro";
export const DOM_FONT_ASSET_PATH = "assets/swifttui-fonts/2184c1f2bac4/";
export const DOM_FONT_FALLBACK =
  '"Menlo", "Consolas", "Liberation Mono", monospace';
export const DOM_UNICODE_FALLBACK =
  '"PingFang SC", "Hiragino Sans", "Noto Sans CJK SC", "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", monospace';
export const DOM_FONT_FACES = [
  { file: "SourceCodePro-Regular.ttf.woff2", weight: "400", style: "normal" },
  { file: "SourceCodePro-Bold.ttf.woff2", weight: "700", style: "normal" },
  { file: "SourceCodePro-It.ttf.woff2", weight: "400", style: "italic" },
  { file: "SourceCodePro-BoldIt.ttf.woff2", weight: "700", style: "italic" },
] as const;

export interface DomFontOptions {
  /** Directory containing the four released faces, resolved against document.baseURI. */
  assetBase?: string | URL;
  /** Bounded font readiness wait, independent of WASM startup (default 2 seconds). */
  timeoutMs?: number;
}
export interface DomFontResult {
  readonly status: "ready" | "fallback" | "disposed";
  readonly family: string;
  readonly diagnostic?: string;
}
interface SharedFaces {
  refs: number;
  alias: string;
  faces: FontFace[];
  ready: Promise<void>;
}
const documents = new WeakMap<Document, Map<string, SharedFaces>>();
let nextAlias = 0;

/** One session owns one settled font choice. Late loads cannot replace its fallback. */
export class DomFontResources {
  private faceLeaseCount = 0;
  get ownedFaceLeases(): number {
    return this.faceLeaseCount;
  }
  private disposed = false;
  private releaseFaces?: () => void;
  private cancelWait?: () => void;
  readonly ready: Promise<DomFontResult>;
  constructor(
    doc: Document,
    family: string,
    size: number,
    options: DomFontOptions = {},
  ) {
    this.ready = this.load(doc, family, size, options).catch(() => {
      this.releaseFaces?.();
      this.releaseFaces = undefined;
      return {
        status: this.disposed ? "disposed" : "fallback",
        family: DOM_FONT_FALLBACK,
        diagnostic:
          "DOM font configuration failed; using the measured system monospace fallback.",
      };
    });
  }
  private async load(
    doc: Document,
    family: string,
    size: number,
    options: DomFontOptions,
  ): Promise<DomFontResult> {
    if (!doc.fonts || typeof FontFace === "undefined")
      return {
        status: "fallback",
        family: DOM_FONT_FALLBACK,
        diagnostic:
          "Font loading is unavailable; using the measured system monospace fallback.",
      };
    let desiredFamily = family;
    let readiness: Promise<unknown>;
    if (family === DOM_FONT_FAMILY) {
      let base: URL;
      try {
        base = new URL(
          String(options.assetBase ?? DOM_FONT_ASSET_PATH),
          doc.baseURI,
        );
      } catch {
        return {
          status: "fallback",
          family: DOM_FONT_FALLBACK,
          diagnostic:
            "Invalid DOM font asset base; using the measured system monospace fallback.",
        };
      }
      if (!base.pathname.endsWith("/")) base.pathname += "/";
      const key = base.href;
      const shared = documents.get(doc) ?? new Map<string, SharedFaces>();
      documents.set(doc, shared);
      let entry = shared.get(key);
      if (!entry) {
        const alias = `SwiftTUIFont${++nextAlias}`;
        const faces = DOM_FONT_FACES.map(
          (face) =>
            new FontFace(
              alias,
              `url(${JSON.stringify(new URL(face.file, base).href)})`,
              { weight: face.weight, style: face.style },
            ),
        );
        entry = { refs: 0, alias, faces, ready: Promise.resolve() };
        const owned = entry;
        entry.ready = Promise.all(faces.map((face) => face.load())).then(() => {
          if (owned.refs > 0) for (const face of faces) doc.fonts.add(face);
        });
        shared.set(key, entry);
      }
      entry.refs++;
      this.faceLeaseCount = entry.faces.length;
      const owned = entry;
      let released = false;
      this.releaseFaces = () => {
        if (released) return;
        released = true;
        this.faceLeaseCount = 0;
        if (--owned.refs === 0) {
          for (const face of owned.faces) doc.fonts.delete(face);
          if (shared.get(key) === owned) shared.delete(key);
        }
      };
      desiredFamily = `"${entry.alias}", ${DOM_UNICODE_FALLBACK}`;
      readiness = entry.ready;
    } else {
      // Named/system custom families remain an explicit embedder choice. Load
      // every requested emphasis face; actual CSS probes decide their geometry.
      readiness = Promise.all(
        ["", "700 ", "italic ", "italic 700 "].map((prefix) =>
          doc.fonts.load(`${prefix}${size}px ${family}`, "Wé"),
        ),
      );
    }
    const waitMs = Math.max(
      0,
      Math.min(
        10000,
        Number.isFinite(options.timeoutMs) ? options.timeoutMs! : 2000,
      ),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const interrupted = new Promise<"timeout" | "disposed">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), waitMs);
      this.cancelWait = () => resolve("disposed");
    });
    const outcome = await Promise.race([
      readiness.then(
        () => "ready" as const,
        () => "failed" as const,
      ),
      interrupted,
    ]);
    clearTimeout(timer);
    this.cancelWait = undefined;
    if (this.disposed || outcome === "disposed")
      return { status: "disposed", family: DOM_FONT_FALLBACK };
    if (outcome === "ready") return { status: "ready", family: desiredFamily };
    this.releaseFaces?.();
    this.releaseFaces = undefined;
    return {
      status: "fallback",
      family: DOM_FONT_FALLBACK,
      diagnostic: `DOM font ${outcome === "timeout" ? "readiness timed out" : "loading failed"}; using the measured system monospace fallback for this session.`,
    };
  }
  dispose(): void {
    this.disposed = true;
    this.cancelWait?.();
    this.releaseFaces?.();
    this.releaseFaces = undefined;
  }
}
