import {
  encodeWebHostTerminalRenderStyleBase64,
  type WebHostTerminalStyle,
} from "./WebHostTerminalStyle.ts";

export interface WebHostSurfaceStyle {
  fg?: string;
  bg?: string;
  em?: number;
  underline?: WebHostSurfaceLineStyle;
  strikethrough?: WebHostSurfaceLineStyle;
  opacity?: number;
}

export interface WebHostSurfaceLineStyle {
  pattern: "solid" | "dot" | "dash" | "dashDot" | "dashDotDot" | "double" | "curly";
  color?: string;
}

export type WebHostSurfaceCell = [
  x: number,
  text: string,
  span: number,
  styleIndex: number,
];

export type WebHostSurfaceRect = [
  x: number,
  y: number,
  width: number,
  height: number,
];

export type WebHostSurfaceSize = [
  width: number,
  height: number,
];

export type WebHostAccessibilityPoint = [
  x: number,
  y: number,
];

export type WebHostAccessibilityLiveRegion = "off" | "polite" | "assertive";

export interface WebHostAccessibilityNode {
  id: string;
  parentId?: string;
  rect: WebHostSurfaceRect;
  role: string;
  label?: string;
  hint?: string;
  /** omitted when false */
  hidden?: boolean;
  liveRegion?: WebHostAccessibilityLiveRegion;
  cursorAnchor?: WebHostAccessibilityPoint;
  isFocused?: boolean;
}

/**
 * One hyperlink run within a row: [x, spanWidth, linkTargetIndex]. The index
 * points into the frame's deduplicated `linkTargets` table.
 */
export type WebHostSurfaceLinkRun = [
  x: number,
  span: number,
  targetIndex: number,
];

/** Hyperlink runs for one row: [rowIndex, runs]. */
export type WebHostSurfaceLinkRow = [
  row: number,
  runs: WebHostSurfaceLinkRun[],
];

export type WebHostFocusSemantics = "none" | "automatic" | "activate" | "edit";

/**
 * The settled focus presentation for a committed frame — the same derivation
 * the Android host consumes (`prefersTextInput` gates its IME).
 */
export interface WebHostFocusPresentation {
  focusedIdentity?: string;
  semantics: WebHostFocusSemantics;
  prefersTextInput: boolean;
  hasFocusedRegion: boolean;
}

export interface WebHostAccessibilityAnnouncement {
  message: string;
  politeness: WebHostAccessibilityLiveRegion;
}

export type WebHostSurfaceImageFormat = "png" | "jpeg" | "gif";

export interface WebHostSurfaceImage {
  id: string;
  format: WebHostSurfaceImageFormat;
  bounds: WebHostSurfaceRect;
  visibleBounds: WebHostSurfaceRect;
  scalingMode: "stretch" | "fit" | "fill";
  pixelSize?: WebHostSurfaceSize;
  dataBase64?: string;
}

export type WebHostSurfaceDamageRange = [
  start: number,
  end: number,
];

export type WebHostSurfaceDamageTextRow = [
  row: number,
  ranges: WebHostSurfaceDamageRange[],
];

export interface WebHostSurfaceDamage {
  textRows: WebHostSurfaceDamageTextRow[];
  requiresFullTextRepaint: boolean;
  requiresFullGraphicsReplay: boolean;
}

/**
 * Per-region scroll extent published with each frame so the host can implement
 * scroll-chaining: capture the wheel only while the region under the pointer can
 * still scroll in the wheel's direction, otherwise let it fall through to the
 * page. The host recomputes the per-direction headroom from `offset`/`content`/
 * the viewport `rect`, mirroring SwiftTUI's
 * `min(max(0, offset), max(0, content - viewport))` clamp.
 */
export interface WebHostScrollRegion {
  /** identity path — same key space as accessibility node ids */
  id: string;
  /** viewport rect in cells: [x, y, width, height] */
  rect: WebHostSurfaceRect;
  /** current clamped scroll offset in cells: [x, y] */
  offset: WebHostAccessibilityPoint;
  /** total content size in cells: [width, height] */
  content: WebHostSurfaceSize;
}

export interface WebHostSurfaceFrame {
  version: 1 | 2;
  sequence?: number;
  width: number;
  height: number;
  styles: Array<WebHostSurfaceStyle | null>;
  rows: WebHostSurfaceCell[][];
  images?: WebHostSurfaceImage[];
  damage?: WebHostSurfaceDamage;
  accessibilityTree?: WebHostAccessibilityNode[];
  accessibilityAnnouncements?: WebHostAccessibilityAnnouncement[];
  scrollRegions?: WebHostScrollRegion[];
  links?: WebHostSurfaceLinkRow[];
  linkTargets?: string[];
  focusPresentation?: WebHostFocusPresentation;
  preferredGridWidth?: number;
  preferredGridHeight?: number;
}

export type WebHostSurfaceDeltaRow = [
  row: number,
  cells: WebHostSurfaceCell[],
];

export interface WebHostSurfaceDeltaFrame {
  version: 3;
  encoding: "delta";
  sequence?: number;
  width: number;
  height: number;
  styles: Array<WebHostSurfaceStyle | null>;
  deltaRows: WebHostSurfaceDeltaRow[];
  images?: WebHostSurfaceImage[];
  damage?: WebHostSurfaceDamage;
  accessibilityTree?: WebHostAccessibilityNode[];
  accessibilityAnnouncements?: WebHostAccessibilityAnnouncement[];
  scrollRegions?: WebHostScrollRegion[];
  links?: WebHostSurfaceLinkRow[];
  linkTargets?: string[];
  focusPresentation?: WebHostFocusPresentation;
  preferredGridWidth?: number;
  preferredGridHeight?: number;
}

export interface WebHostRuntimeIssue {
  severity: "warning" | "error";
  code: string;
  message: string;
  description: string;
  identity?: string;
  source?: string;
}

export interface WebHostFrameDiagnosticRecord {
  format: "swift-tui-frame-diagnostics-v1";
  header: string[];
  fields: string[];
}

export type WebHostOutputRecord =
  | { type: "surface"; frame: WebHostSurfaceFrame }
  | { type: "clipboard"; text: string }
  | { type: "runtimeIssue"; issue: WebHostRuntimeIssue }
  | { type: "frameDiagnostic"; diagnostic: WebHostFrameDiagnosticRecord }
  | { type: "text"; text: string };

export interface WebHostOutputSink {
  presentSurface(frame: WebHostSurfaceFrame): void;
  writeClipboard?(text: string): void | Promise<void>;
  notifyRuntimeIssue?(issue: WebHostRuntimeIssue): void;
  recordFrameDiagnostic?(diagnostic: WebHostFrameDiagnosticRecord): void;
  writeOutput?(text: string): void;
  writeError?(text: string): void;
}

export interface WebHostKeyInput {
  key:
    | "return"
    | "space"
    | "tab"
    | "arrowLeft"
    | "arrowRight"
    | "arrowUp"
    | "arrowDown"
    | "backspace"
    | "escape"
    | "home"
    | "end"
    | "character";
  character?: string;
  modifiers?: number;
}

export interface WebHostMouseInput {
  kind: "down" | "up" | "moved" | "dragged" | "scrolled";
  x: number;
  y: number;
  button?: "primary" | "middle" | "secondary";
  deltaX?: number;
  deltaY?: number;
  modifiers?: number;
}

const recordPrefix = "\u001E";
const textEncoder = new TextEncoder();

/**
 * The newest `surface` record version this runtime understands. Unknown
 * additive object keys are ignored by design (older runtimes render newer
 * frames), but a frame declaring a NEWER version than this is surfaced as an
 * error-severity runtime issue instead of silently degrading to a text
 * diagnostic — silent version skew is the failure mode this guards against
 * (F57).
 */
export const SUPPORTED_SURFACE_VERSION = 3;

export class WebHostOutputDecoder {
  private readonly textDecoder = new TextDecoder();
  private bufferedText = "";
  private lastSurfaceFrame?: WebHostSurfaceFrame;

  feed(
    chunk: Uint8Array
  ): WebHostOutputRecord[] {
    this.bufferedText += this.textDecoder.decode(chunk, { stream: true });
    const records: WebHostOutputRecord[] = [];

    while (true) {
      const newlineIndex = this.bufferedText.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }

      const line = this.bufferedText.slice(0, newlineIndex);
      this.bufferedText = this.bufferedText.slice(newlineIndex + 1);
      records.push(this.decodeLine(line));
    }

    if (this.bufferedText.length > 4096 && !this.bufferedText.startsWith(recordPrefix)) {
      records.push({ type: "text", text: this.bufferedText });
      this.bufferedText = "";
    }

    return records;
  }

  flush(): WebHostOutputRecord[] {
    if (!this.bufferedText) {
      return [];
    }
    const text = this.bufferedText;
    this.bufferedText = "";
    return [this.decodeLine(text)];
  }

  private decodeLine(
    line: string
  ): WebHostOutputRecord {
    if (line.startsWith(`${recordPrefix}clipboard:`)) {
      try {
        const record = JSON.parse(line.slice(`${recordPrefix}clipboard:`.length));
        if (isWebHostClipboardRecord(record)) {
          return { type: "clipboard", text: record.text };
        }
      } catch {
        // Fall through to the text path below so malformed output remains visible.
      }

      return { type: "text", text: `${line}\n` };
    }

    if (line.startsWith(`${recordPrefix}runtimeIssue:`)) {
      try {
        const record = JSON.parse(line.slice(`${recordPrefix}runtimeIssue:`.length));
        if (isWebHostRuntimeIssue(record)) {
          return { type: "runtimeIssue", issue: record };
        }
      } catch {
        // Fall through to the text path below so malformed output remains visible.
      }

      return { type: "text", text: `${line}\n` };
    }

    if (line.startsWith(`${recordPrefix}frameDiagnostic:`)) {
      try {
        const record = JSON.parse(line.slice(`${recordPrefix}frameDiagnostic:`.length));
        if (isWebHostFrameDiagnosticRecord(record)) {
          return { type: "frameDiagnostic", diagnostic: record };
        }
      } catch {
        // Fall through to the text path below so malformed output remains visible.
      }

      return { type: "text", text: `${line}\n` };
    }

    if (!line.startsWith(`${recordPrefix}surface:`)) {
      return { type: "text", text: `${line}\n` };
    }

    try {
      const frame = JSON.parse(line.slice(`${recordPrefix}surface:`.length));
      if (declaresNewerSurfaceVersion(frame)) {
        return {
          type: "runtimeIssue",
          issue: {
            severity: "error",
            code: "surface.unsupportedVersion",
            message: `SwiftTUI surface version ${frame.version} is newer than the supported ${SUPPORTED_SURFACE_VERSION}`,
            description: "The app emitted a surface record with version "
              + `${frame.version}, but this @swifttui/web runtime understands `
              + `versions up to ${SUPPORTED_SURFACE_VERSION}. Update @swifttui/web `
              + "to render it.",
          },
        };
      }
      if (isWebHostSurfaceFrame(frame)) {
        this.lastSurfaceFrame = frame;
        return { type: "surface", frame };
      }
      if (isWebHostSurfaceDeltaFrame(frame)) {
        const materialized = this.materializeDeltaFrame(frame);
        if (materialized) {
          this.lastSurfaceFrame = materialized;
          return { type: "surface", frame: materialized };
        }
      }
    } catch {
      // Fall through to the text path below so malformed output remains visible.
    }

    return { type: "text", text: `${line}\n` };
  }

  private materializeDeltaFrame(
    frame: WebHostSurfaceDeltaFrame
  ): WebHostSurfaceFrame | undefined {
    const baseline = this.lastSurfaceFrame;
    if (!baseline || baseline.width !== frame.width || baseline.height !== frame.height) {
      return undefined;
    }

    const rows = baseline.rows.slice();
    for (const [row, cells] of frame.deltaRows) {
      if (!Number.isSafeInteger(row) || row < 0 || row >= frame.height) {
        return undefined;
      }
      rows[row] = cells;
    }

    return {
      version: baseline.version,
      sequence: frame.sequence,
      width: frame.width,
      height: frame.height,
      styles: frame.styles,
      rows,
      images: frame.images,
      damage: frame.damage,
      accessibilityTree: frame.accessibilityTree,
      accessibilityAnnouncements: frame.accessibilityAnnouncements,
      scrollRegions: frame.scrollRegions,
      links: frame.links,
      linkTargets: frame.linkTargets,
      focusPresentation: frame.focusPresentation,
      preferredGridWidth: frame.preferredGridWidth,
      preferredGridHeight: frame.preferredGridHeight,
    };
  }
}

function declaresNewerSurfaceVersion(
  value: unknown
): value is { version: number } {
  if (!value || typeof value !== "object") {
    return false;
  }
  const version = (value as { version?: unknown }).version;
  return typeof version === "number"
    && Number.isSafeInteger(version)
    && version > SUPPORTED_SURFACE_VERSION;
}

function isWebHostClipboardRecord(
  value: unknown
): value is { text: string } {
  return !!value && typeof value === "object" && typeof (value as { text?: unknown }).text === "string";
}

function isWebHostRuntimeIssue(
  value: unknown
): value is WebHostRuntimeIssue {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<WebHostRuntimeIssue>;
  return (record.severity === "warning" || record.severity === "error")
    && typeof record.code === "string"
    && typeof record.message === "string"
    && typeof record.description === "string"
    && (record.identity === undefined || typeof record.identity === "string")
    && (record.source === undefined || typeof record.source === "string");
}

function isWebHostFrameDiagnosticRecord(
  value: unknown
): value is WebHostFrameDiagnosticRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<WebHostFrameDiagnosticRecord>;
  return record.format === "swift-tui-frame-diagnostics-v1"
    && Array.isArray(record.header)
    && record.header.every((field) => typeof field === "string")
    && Array.isArray(record.fields)
    && record.fields.every((field) => typeof field === "string");
}

export function encodeResizeControlMessage(
  columns: number,
  rows: number,
  cellWidth?: number,
  cellHeight?: number
): Uint8Array {
  const normalizedColumns = Math.max(1, Math.round(columns));
  const normalizedRows = Math.max(1, Math.round(rows));
  if (cellWidth && cellHeight) {
    return textEncoder.encode(
      `${recordPrefix}resize:${normalizedColumns}:${normalizedRows}:${Math.max(1, Math.round(cellWidth))}:${Math.max(1, Math.round(cellHeight))}\n`
    );
  }

  return textEncoder.encode(`${recordPrefix}resize:${normalizedColumns}:${normalizedRows}\n`);
}

export function encodeRenderStyleControlMessage(
  style: WebHostTerminalStyle
): Uint8Array {
  const encoded = encodeWebHostTerminalRenderStyleBase64(style);
  return textEncoder.encode(`${recordPrefix}style:${encoded}\n`);
}

export function encodeCapabilitiesControlMessage(): Uint8Array {
  // The client's wire-capability declaration, sent once after the socket
  // opens. The declaration is truthful today: this decoder materializes v3
  // delta frames (`materializeDeltaFrame`). Byte shape and key order are
  // pinned by the cross-repo fixture Fixtures/Transport/web-caps-record.txt
  // — swift-tui's input parser consumes the identical bytes, and the
  // coordination root's transport_fixture_sync gate keeps the copies in
  // lockstep. Servers that predate the record drop it silently, so the
  // session degrades to today's full-frame defaults.
  return textEncoder.encode(
    `${recordPrefix}caps:{"maxWebSurfaceVersion":3,"acceptsDeltaFrames":true}\n`
  );
}

export function encodeKeyInputMessage(
  input: WebHostKeyInput
): Uint8Array {
  const modifiers = Math.max(0, Math.round(input.modifiers ?? 0));
  if (input.key === "character") {
    return textEncoder.encode(
      `${recordPrefix}key:character:${encodeURIComponent(input.character ?? "")}:${modifiers}\n`
    );
  }
  return textEncoder.encode(`${recordPrefix}key:${input.key}:${modifiers}\n`);
}

export function encodePasteInputMessage(
  text: string
): Uint8Array {
  return textEncoder.encode(`${recordPrefix}paste:${encodeURIComponent(text)}\n`);
}

export function encodeMouseInputMessage(
  input: WebHostMouseInput
): Uint8Array {
  return textEncoder.encode(
    recordPrefix + [
      "mouse",
      input.kind,
      formatCellCoordinate(input.x),
      formatCellCoordinate(input.y),
      input.button ?? "none",
      Math.round(input.deltaX ?? 0),
      Math.round(input.deltaY ?? 0),
      Math.max(0, Math.round(input.modifiers ?? 0)),
    ].join(":") + "\n"
  );
}

function formatCellCoordinate(
  value: number
): string {
  return Number.isFinite(value) ? String(value) : "0";
}

function isWebHostSurfaceFrame(
  value: unknown
): value is WebHostSurfaceFrame {
  if (!value || typeof value !== "object") {
    return false;
  }
  const frame = value as Partial<WebHostSurfaceFrame>;
  return (frame.version === 1 || frame.version === 2)
    && (
      frame.sequence === undefined
        || (Number.isSafeInteger(frame.sequence) && frame.sequence >= 0)
    )
    && typeof frame.width === "number"
    && typeof frame.height === "number"
    && Array.isArray(frame.styles)
    && Array.isArray(frame.rows)
    && frame.rows.every(isWebHostSurfaceRow)
    && (frame.images === undefined || isWebHostSurfaceImages(frame.images))
    && (frame.damage === undefined || isWebHostSurfaceDamage(frame.damage))
    && (
      frame.accessibilityTree === undefined
        || isWebHostAccessibilityNodes(frame.accessibilityTree)
    )
    && (
      frame.accessibilityAnnouncements === undefined
        || isWebHostAccessibilityAnnouncements(frame.accessibilityAnnouncements)
    )
    && (frame.scrollRegions === undefined || isWebHostScrollRegions(frame.scrollRegions))
    && hasValidAdditiveFrameFields(frame);
}

function isWebHostSurfaceDeltaFrame(
  value: unknown
): value is WebHostSurfaceDeltaFrame {
  if (!value || typeof value !== "object") {
    return false;
  }
  const frame = value as Partial<WebHostSurfaceDeltaFrame>;
  return frame.version === 3
    && frame.encoding === "delta"
    && (
      frame.sequence === undefined
        || (Number.isSafeInteger(frame.sequence) && frame.sequence >= 0)
    )
    && typeof frame.width === "number"
    && typeof frame.height === "number"
    && Array.isArray(frame.styles)
    && Array.isArray(frame.deltaRows)
    && frame.deltaRows.every(isWebHostSurfaceDeltaRow)
    && (frame.images === undefined || isWebHostSurfaceImages(frame.images))
    && (frame.damage === undefined || isWebHostSurfaceDamage(frame.damage))
    && (
      frame.accessibilityTree === undefined
        || isWebHostAccessibilityNodes(frame.accessibilityTree)
    )
    && (
      frame.accessibilityAnnouncements === undefined
        || isWebHostAccessibilityAnnouncements(frame.accessibilityAnnouncements)
    )
    && (frame.scrollRegions === undefined || isWebHostScrollRegions(frame.scrollRegions))
    && hasValidAdditiveFrameFields(frame);
}

/**
 * The F19 additive fields shared by the full and delta record shapes. Absent
 * means "feature not present" — servers older than the field omit it.
 */
function hasValidAdditiveFrameFields(
  frame: Partial<WebHostSurfaceFrame> | Partial<WebHostSurfaceDeltaFrame>
): boolean {
  return (frame.links === undefined || isWebHostSurfaceLinks(frame.links))
    && (frame.linkTargets === undefined || isWebHostSurfaceLinkTargets(frame.linkTargets))
    && (
      frame.focusPresentation === undefined
        || isWebHostFocusPresentation(frame.focusPresentation)
    )
    && (
      frame.preferredGridWidth === undefined
        || (Number.isSafeInteger(frame.preferredGridWidth) && frame.preferredGridWidth >= 0)
    )
    && (
      frame.preferredGridHeight === undefined
        || (Number.isSafeInteger(frame.preferredGridHeight) && frame.preferredGridHeight >= 0)
    );
}

function isWebHostSurfaceLinks(
  value: unknown
): value is WebHostSurfaceLinkRow[] {
  return Array.isArray(value) && value.every(isWebHostSurfaceLinkRow);
}

function isWebHostSurfaceLinkRow(
  value: unknown
): value is WebHostSurfaceLinkRow {
  return Array.isArray(value)
    && value.length === 2
    && Number.isSafeInteger(value[0])
    && value[0] >= 0
    && Array.isArray(value[1])
    && value[1].every(isWebHostSurfaceLinkRun);
}

function isWebHostSurfaceLinkRun(
  value: unknown
): value is WebHostSurfaceLinkRun {
  if (!Array.isArray(value) || value.length !== 3) {
    return false;
  }
  const [x, span, targetIndex] = value as number[];
  return Number.isSafeInteger(x)
    && x >= 0
    && Number.isSafeInteger(span)
    && span >= 1
    && Number.isSafeInteger(targetIndex)
    && targetIndex >= 0;
}

function isWebHostSurfaceLinkTargets(
  value: unknown
): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isWebHostFocusPresentation(
  value: unknown
): value is WebHostFocusPresentation {
  if (!value || typeof value !== "object") {
    return false;
  }
  const presentation = value as Partial<WebHostFocusPresentation>;
  return (
    presentation.focusedIdentity === undefined
      || typeof presentation.focusedIdentity === "string"
  )
    && (
      presentation.semantics === "none"
        || presentation.semantics === "automatic"
        || presentation.semantics === "activate"
        || presentation.semantics === "edit"
    )
    && typeof presentation.prefersTextInput === "boolean"
    && typeof presentation.hasFocusedRegion === "boolean";
}

function isWebHostSurfaceDeltaRow(
  value: unknown
): value is WebHostSurfaceDeltaRow {
  return Array.isArray(value)
    && value.length === 2
    && Number.isSafeInteger(value[0])
    && value[0] >= 0
    && isWebHostSurfaceRow(value[1]);
}

function isWebHostSurfaceRow(
  value: unknown
): value is WebHostSurfaceCell[] {
  return Array.isArray(value) && value.every(isWebHostSurfaceCell);
}

function isWebHostSurfaceCell(
  value: unknown
): value is WebHostSurfaceCell {
  return Array.isArray(value)
    && value.length === 4
    && Number.isSafeInteger(value[0])
    && value[0] >= 0
    && typeof value[1] === "string"
    && Number.isSafeInteger(value[2])
    && value[2] >= 1
    && Number.isSafeInteger(value[3])
    && value[3] >= 0;
}

function isWebHostAccessibilityNodes(
  value: unknown
): value is WebHostAccessibilityNode[] {
  return Array.isArray(value) && value.every(isWebHostAccessibilityNode);
}

function isWebHostAccessibilityNode(
  value: unknown
): value is WebHostAccessibilityNode {
  if (!value || typeof value !== "object") {
    return false;
  }
  const node = value as Partial<WebHostAccessibilityNode>;
  return typeof node.id === "string"
    && (node.parentId === undefined || typeof node.parentId === "string")
    && isWebHostSurfaceRect(node.rect)
    && typeof node.role === "string"
    && (node.label === undefined || typeof node.label === "string")
    && (node.hint === undefined || typeof node.hint === "string")
    && (node.hidden === undefined || typeof node.hidden === "boolean")
    && (
      node.liveRegion === undefined
        || node.liveRegion === "off"
        || node.liveRegion === "polite"
        || node.liveRegion === "assertive"
    )
    && (node.cursorAnchor === undefined || isWebHostAccessibilityPoint(node.cursorAnchor))
    && (node.isFocused === undefined || typeof node.isFocused === "boolean");
}

function isWebHostAccessibilityPoint(
  value: unknown
): value is WebHostAccessibilityPoint {
  return Array.isArray(value)
    && value.length === 2
    && value.every((entry) => typeof entry === "number");
}

function isWebHostAccessibilityAnnouncements(
  value: unknown
): value is WebHostAccessibilityAnnouncement[] {
  return Array.isArray(value) && value.every(isWebHostAccessibilityAnnouncement);
}

function isWebHostAccessibilityAnnouncement(
  value: unknown
): value is WebHostAccessibilityAnnouncement {
  if (!value || typeof value !== "object") {
    return false;
  }
  const announcement = value as Partial<WebHostAccessibilityAnnouncement>;
  return typeof announcement.message === "string"
    && (
      announcement.politeness === "off"
        || announcement.politeness === "polite"
        || announcement.politeness === "assertive"
    );
}

function isWebHostSurfaceImages(
  value: unknown
): value is WebHostSurfaceImage[] {
  return Array.isArray(value) && value.every(isWebHostSurfaceImage);
}

function isWebHostSurfaceImage(
  value: unknown
): value is WebHostSurfaceImage {
  if (!value || typeof value !== "object") {
    return false;
  }
  const image = value as Partial<WebHostSurfaceImage>;
  return typeof image.id === "string"
    && isWebHostSurfaceImageFormat(image.format)
    && isWebHostSurfaceRect(image.bounds)
    && isWebHostSurfaceRect(image.visibleBounds)
    && isWebHostSurfaceScalingMode(image.scalingMode)
    && (image.pixelSize === undefined || isWebHostSurfaceSize(image.pixelSize))
    && (image.dataBase64 === undefined || typeof image.dataBase64 === "string");
}

function isWebHostSurfaceDamage(
  value: unknown
): value is WebHostSurfaceDamage {
  if (!value || typeof value !== "object") {
    return false;
  }
  const damage = value as Partial<WebHostSurfaceDamage>;
  return Array.isArray(damage.textRows)
    && damage.textRows.every(isWebHostSurfaceDamageTextRow)
    && typeof damage.requiresFullTextRepaint === "boolean"
    && typeof damage.requiresFullGraphicsReplay === "boolean";
}

function isWebHostSurfaceDamageTextRow(
  value: unknown
): value is WebHostSurfaceDamageTextRow {
  return Array.isArray(value)
    && value.length === 2
    && typeof value[0] === "number"
    && Array.isArray(value[1])
    && value[1].every(isWebHostSurfaceDamageRange);
}

function isWebHostSurfaceDamageRange(
  value: unknown
): value is WebHostSurfaceDamageRange {
  return Array.isArray(value)
    && value.length === 2
    && typeof value[0] === "number"
    && typeof value[1] === "number";
}

function isWebHostSurfaceImageFormat(
  value: unknown
): value is WebHostSurfaceImageFormat {
  return value === "png" || value === "jpeg" || value === "gif";
}

function isWebHostScrollRegions(
  value: unknown
): value is WebHostScrollRegion[] {
  return Array.isArray(value) && value.every(isWebHostScrollRegion);
}

function isWebHostScrollRegion(
  value: unknown
): value is WebHostScrollRegion {
  if (!value || typeof value !== "object") {
    return false;
  }
  const region = value as Partial<WebHostScrollRegion>;
  return typeof region.id === "string"
    && isWebHostSurfaceRect(region.rect)
    && isWebHostSurfaceSize(region.offset)
    && isWebHostSurfaceSize(region.content);
}

function isWebHostSurfaceRect(
  value: unknown
): value is WebHostSurfaceRect {
  return Array.isArray(value)
    && value.length === 4
    && value.every((entry) => typeof entry === "number");
}

function isWebHostSurfaceSize(
  value: unknown
): value is WebHostSurfaceSize {
  return Array.isArray(value)
    && value.length === 2
    && value.every((entry) => typeof entry === "number");
}

function isWebHostSurfaceScalingMode(
  value: unknown
): value is WebHostSurfaceImage["scalingMode"] {
  return value === "stretch" || value === "fit" || value === "fill";
}
