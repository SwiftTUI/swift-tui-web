import { type DomCellMeasurement, DomCellProbe } from "./DomCellMetrics.ts";
import {
  HOST_WIRE_MAX_GRID_CELLS,
  HOST_WIRE_MAX_GRID_DIMENSION,
} from "./HostWireBudget.ts";
import { fontForStyle } from "./SurfaceTypography.ts";
import type { ResolvedWebHostTerminalStyle } from "./WebHostTerminalStyle.ts";

export interface DomContentBox {
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

/** CSS layout pitch is independent of device-pixel output scale. */
export interface DomGeometrySnapshot {
  readonly revision: number;
  /** Producer layout revision; differs during a user-font reprojection. */
  readonly sourceRevision?: number;
  readonly projected?: boolean;
  readonly fontIdentity: string;
  readonly fontSize: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly paragraphSpacing?: number;
  readonly baseline: number;
  readonly columns: number;
  readonly rows: number;
  readonly content: Readonly<DomContentBox>;
  readonly bounded: boolean;
}

export function makeDomGeometry(
  revision: number,
  fontIdentity: string,
  cells: DomCellMeasurement,
  content: DomContentBox,
): DomGeometrySnapshot | undefined {
  const numbers = [
    revision,
    cells.width,
    cells.height,
    cells.baseline,
    cells.fontSize,
    ...Object.values(content),
  ];
  if (
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    !numbers.every(Number.isFinite) ||
    content.width <= 0 ||
    content.height <= 0 ||
    cells.width <= 0 ||
    cells.height <= 0 ||
    content.scaleX <= 0 ||
    content.scaleY <= 0
  )
    return undefined;
  const cellWidth = Math.ceil(cells.width),
    cellHeight = Math.ceil(cells.height);
  const requestedColumns = Math.floor(content.width / cellWidth),
    requestedRows = Math.floor(content.height / cellHeight);
  if (requestedColumns < 1 || requestedRows < 1) return undefined;
  const columns = Math.min(HOST_WIRE_MAX_GRID_DIMENSION, requestedColumns);
  const rows = Math.min(
    HOST_WIRE_MAX_GRID_DIMENSION,
    requestedRows,
    Math.floor(HOST_WIRE_MAX_GRID_CELLS / columns),
  );
  return Object.freeze({
    revision,
    fontIdentity,
    fontSize: cells.fontSize,
    cellWidth,
    cellHeight,
    baseline: cells.baseline,
    columns,
    rows,
    content: Object.freeze({ ...content }),
    bounded: columns !== requestedColumns || rows !== requestedRows,
  });
}

/** Reject unsupported transforms instead of treating their bounding box as an inverse. */
function validateTransforms(mount: HTMLElement): void {
  const view = mount.ownerDocument?.defaultView;
  if (!view) return;
  for (let node: HTMLElement | null = mount; node; node = node.parentElement) {
    const css = view.getComputedStyle(node);
    if (
      css.perspective !== "none" ||
      (css.rotate && css.rotate !== "none" && css.rotate !== "0deg")
    )
      throw new Error(
        "DOM host supports positive axis-aligned scale and translation; rotation, skew and perspective require a different embedding.",
      );
    if (
      css.scale &&
      css.scale !== "none" &&
      css.scale.split(/\s+/).some((v) => Number(v) <= 0)
    )
      throw new Error("DOM host requires a positive embedding scale.");
    if (css.transform !== "none") {
      const matrix = new DOMMatrixReadOnly(css.transform);
      if (
        !matrix.is2D ||
        Math.abs(matrix.b) > 1e-8 ||
        Math.abs(matrix.c) > 1e-8 ||
        matrix.a <= 0 ||
        matrix.d <= 0
      )
        throw new Error(
          "DOM host supports positive axis-aligned scale and translation; rotation, skew and perspective require a different embedding.",
        );
    }
  }
}

export function measureDomContentBox(
  mount: HTMLElement,
): DomContentBox | undefined {
  const rect = mount.getBoundingClientRect();
  if (!(rect.width > 0 && rect.height > 0)) return undefined;
  validateTransforms(mount);
  const css = mount.ownerDocument?.defaultView?.getComputedStyle(mount);
  const number = (value: string | undefined) =>
    Number.parseFloat(value ?? "") || 0;
  const pl = number(css?.paddingLeft),
    pr = number(css?.paddingRight),
    pt = number(css?.paddingTop),
    pb = number(css?.paddingBottom);
  const bl = number(css?.borderLeftWidth),
    br = number(css?.borderRightWidth),
    bt = number(css?.borderTopWidth),
    bb = number(css?.borderBottomWidth);
  const borderBox = css?.boxSizing === "border-box";
  const width = css
    ? number(css.width) - (borderBox ? pl + pr + bl + br : 0)
    : rect.width;
  const height = css
    ? number(css.height) - (borderBox ? pt + pb + bt + bb : 0)
    : rect.height;
  const scaleX = rect.width / (width + pl + pr + bl + br),
    scaleY = rect.height / (height + pt + pb + bt + bb);
  if (!(width > 0 && height > 0 && scaleX > 0 && scaleY > 0)) return undefined;
  return {
    width,
    height,
    scaleX,
    scaleY,
    left: rect.left + (bl + pl) * scaleX,
    top: rect.top + (bt + pt) * scaleY,
    offsetX: pl,
    offsetY: pt,
  };
}

/** Owns measurements; transport correlation is applied by the scene runtime. */
export class DomGeometryController {
  readonly probe: DomCellProbe;
  pending?: DomGeometrySnapshot;
  presented?: DomGeometrySnapshot;
  private paragraphProbe?: HTMLElement;
  private paragraphSupport = false;
  private typography?: { identity: string; cells: DomCellMeasurement };
  constructor(private readonly mount: HTMLElement) {
    this.probe = new DomCellProbe(mount);
  }
  resetParagraphs(): void {
    this.paragraphSupport = false;
    this.paragraphProbe?.remove();
    this.paragraphProbe = undefined;
  }
  enableParagraphs(): boolean {
    if (this.paragraphSupport) return false;
    this.paragraphSupport = true;
    return true;
  }
  private paragraphSpacing(
    style: ResolvedWebHostTerminalStyle,
    cellHeight: number,
  ): number | undefined {
    if (!this.paragraphSupport) return undefined;
    const view = this.mount.ownerDocument?.defaultView;
    if (!view) return 0;
    if (!this.paragraphProbe?.isConnected) {
      const probe = this.mount.ownerDocument.createElement("p");
      probe.className = "webhost-scene__paragraph";
      probe.setAttribute("data-paragraph-probe", "");
      probe.setAttribute("aria-hidden", "true");
      Object.assign(probe.style, {
        position: "absolute",
        visibility: "hidden",
        pointerEvents: "none",
        width: "0",
        height: "0",
        margin: "0",
        padding: "0",
        overflow: "hidden",
      });
      (
        this.mount.querySelector(".webhost-scene__surface-rows") ?? this.mount
      ).appendChild(probe);
      this.paragraphProbe = probe;
    }
    this.paragraphProbe.style.font = fontForStyle(style);
    let pixels = 0;
    for (const paragraph of this.mount.querySelectorAll<HTMLElement>(
      "p.webhost-scene__paragraph",
    )) {
      const margin = Number.parseFloat(
        view.getComputedStyle(paragraph).marginBottom,
      );
      if (Number.isFinite(margin)) pixels = Math.max(pixels, margin);
    }
    return Math.min(8192, Math.ceil(pixels / cellHeight));
  }
  measure(
    style: ResolvedWebHostTerminalStyle,
  ): DomGeometrySnapshot | undefined {
    const content = measureDomContentBox(this.mount);
    if (!content) return undefined;
    let cells = this.probe.measure(style, content.scaleX, content.scaleY);
    if (!cells) return undefined;
    // Round once per effective typography. Platform emoji strikes may change
    // their hinted advance under CSS zoom while the base font and line box do
    // not change. That raster variation must not renegotiate the app's grid.
    const prior = this.typography;
    if (
      prior?.identity === (cells.fontFamily ?? style.fontFamily) &&
      prior.cells.fontSize === cells.fontSize &&
      prior.cells.spacingKey === cells.spacingKey &&
      Math.abs(prior.cells.advance - cells.advance) <= 1 / 32 &&
      prior.cells.height === cells.height
    ) {
      cells = prior.cells;
    } else
      this.typography = {
        identity: cells.fontFamily ?? style.fontFamily,
        cells,
      };
    const previous = this.pending;
    const measured = makeDomGeometry(
      previous?.revision ?? 1,
      cells.fontFamily ?? style.fontFamily,
      cells,
      content,
    );
    if (!measured) return undefined;
    const next = {
      ...measured,
      paragraphSpacing: this.paragraphSpacing(
        {
          ...style,
          fontSize: cells.fontSize,
          fontFamily: cells.fontFamily ?? style.fontFamily,
        },
        measured.cellHeight,
      ),
    };
    // Moving the page changes the client mapping, not the producer's layout.
    const layoutChanged =
      previous &&
      [
        "fontIdentity",
        "fontSize",
        "cellWidth",
        "cellHeight",
        "paragraphSpacing",
        "columns",
        "rows",
      ].some(
        (key) =>
          previous[key as keyof DomGeometrySnapshot] !==
          next[key as keyof DomGeometrySnapshot],
      );
    if (layoutChanged && previous.revision >= Number.MAX_SAFE_INTEGER)
      throw new Error("DOM geometry revision exhausted; remount the scene.");
    this.pending = Object.freeze({
      ...next,
      revision: next.revision + (layoutChanged ? 1 : 0),
    });
    return this.pending;
  }
  present(snapshot: DomGeometrySnapshot): void {
    this.presented = snapshot;
  }
  dispose(): void {
    this.probe.dispose();
    this.paragraphProbe?.remove();
    this.paragraphProbe = undefined;
    this.pending = undefined;
    this.presented = undefined;
  }
}
