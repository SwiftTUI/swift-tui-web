import {
  encodeKeyInputMessage,
  encodeMouseInputMessage,
  encodePasteInputMessage,
  type WebHostKeyInput,
} from "./WebHostSurfaceTransport.ts";

/** A resolved cell-grid location (fractional cell coordinates). */
export interface CellLocation {
  x: number;
  y: number;
}

/**
 * Pointer button identity in the wire vocabulary. Mirrors the values the Swift
 * host expects on `mouse:` records.
 */
export type PointerButton = "primary" | "middle" | "secondary";

/**
 * The presented cell pitch (CSS pixels) and grid extent (cells) that convert a
 * wheel's pixel, line or page deltas into whole terminal cells.
 */
export interface WheelCellMetrics {
  cellWidth: number;
  cellHeight: number;
  columns: number;
  rows: number;
}

/**
 * The most cells one encoded wheel record carries on each axis. Larger
 * per-event travel (an accelerated spin, a page delta on a tall grid, events
 * the browser coalesced) is clamped to it and the excess is discarded rather
 * than deferred, so no single wheel event can scroll farther.
 */
export const MAX_WHEEL_CELL_DELTA = 16;

const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

/**
 * Encodes DOM keyboard/pointer/wheel/paste events into the `web-surface` wire
 * messages the SwiftTUI host consumes. This collaborator owns the translation
 * from browser event vocabulary (key names, button indices, wheel deltas,
 * modifier flags) to the transport's message vocabulary; it produces raw byte
 * chunks and holds no DOM or geometry state. Its only state is the sub-cell
 * wheel travel (under one cell per axis) carried to the next wheel event.
 *
 * Hit-testing (pixel → cell) lives in the host, which passes already-resolved
 * {@link CellLocation}s and {@link WheelCellMetrics} here so the encoder stays
 * free of layout concerns.
 */
export class InputEventEncoder {
  private wheelRemainderX = 0;
  private wheelRemainderY = 0;

  /**
   * Builds the key message for a keyboard event, or `undefined` when the event
   * does not map to a forwarded key (e.g. a multi-codepoint composed string).
   * Returning `undefined` lets the host leave the event unhandled.
   */
  encodeKey(event: KeyboardEvent): Uint8Array | undefined {
    const key = keyInputFromKeyboardEvent(event);
    if (!key) {
      return undefined;
    }
    return encodeKeyInputMessage({
      ...key,
      modifiers: modifierMask(event),
    });
  }

  encodePaste(text: string): Uint8Array {
    return encodePasteInputMessage(text);
  }

  encodePointerDown(
    location: CellLocation,
    button: PointerButton,
    event: PointerEvent,
    geometryRevision?: number,
    viewportRevision?: number,
  ): Uint8Array {
    return encodeMouseInputMessage(
      {
        kind: "down",
        x: location.x,
        y: location.y,
        button,
        modifiers: modifierMask(event),
      },
      geometryRevision,
      viewportRevision,
    );
  }

  encodePointerUp(
    location: CellLocation,
    button: PointerButton,
    event: PointerEvent,
    geometryRevision?: number,
    viewportRevision?: number,
  ): Uint8Array {
    return encodeMouseInputMessage(
      {
        kind: "up",
        x: location.x,
        y: location.y,
        button,
        modifiers: modifierMask(event),
      },
      geometryRevision,
      viewportRevision,
    );
  }

  encodePointerCancel(
    location: CellLocation,
    geometryRevision?: number,
    viewportRevision?: number,
  ): Uint8Array {
    return encodeMouseInputMessage(
      { kind: "cancelled", x: location.x, y: location.y },
      geometryRevision,
      viewportRevision,
    );
  }

  encodePointerMove(
    location: CellLocation,
    button: PointerButton,
    event: PointerEvent,
    geometryRevision?: number,
    viewportRevision?: number,
  ): Uint8Array {
    return encodeMouseInputMessage(
      {
        kind: event.buttons ? "dragged" : "moved",
        x: location.x,
        y: location.y,
        button,
        modifiers: modifierMask(event),
      },
      geometryRevision,
      viewportRevision,
    );
  }

  /**
   * Builds the scrolled record for a wheel the host captured, in whole
   * terminal cells: pixel deltas divide by the presented cell pitch, line
   * deltas are one cell per line, and page deltas are the presented grid.
   * Sub-cell travel carries to the next wheel; a delta opposing the carried
   * travel drops it first. Each axis is bounded by
   * {@link MAX_WHEEL_CELL_DELTA}. Returns `undefined` when neither axis has
   * reached a whole cell; the host still consumes the event.
   */
  encodeWheel(
    location: CellLocation,
    event: WheelEvent,
    metrics: WheelCellMetrics,
    geometryRevision?: number,
    viewportRevision?: number,
  ): Uint8Array | undefined {
    // Read the mode before the deltas: Firefox may report line units only to a
    // page that has read `deltaMode` first.
    const mode = event.deltaMode;
    const [deltaX, remainderX] = wholeWheelCells(
      this.wheelRemainderX,
      wheelTravel(event.deltaX, mode, metrics.cellWidth, metrics.columns),
    );
    const [deltaY, remainderY] = wholeWheelCells(
      this.wheelRemainderY,
      wheelTravel(event.deltaY, mode, metrics.cellHeight, metrics.rows),
    );
    this.wheelRemainderX = remainderX;
    this.wheelRemainderY = remainderY;
    if (deltaX === 0 && deltaY === 0) {
      return undefined;
    }
    return encodeMouseInputMessage(
      {
        kind: "scrolled",
        x: location.x,
        y: location.y,
        deltaX,
        deltaY,
        modifiers: modifierMask(event),
      },
      geometryRevision,
      viewportRevision,
    );
  }

  /** Translates a DOM `MouseEvent.button` index into the wire button identity. */
  pointerButton(button: number): PointerButton {
    return pointerButton(button);
  }
}

function keyInputFromKeyboardEvent(
  event: KeyboardEvent,
): Pick<WebHostKeyInput, "key" | "character"> | undefined {
  switch (event.key) {
    case "Enter":
      return { key: "return" };
    case " ":
      return { key: "space" };
    case "Tab":
      return { key: "tab" };
    case "ArrowLeft":
      return { key: "arrowLeft" };
    case "ArrowRight":
      return { key: "arrowRight" };
    case "ArrowUp":
      return { key: "arrowUp" };
    case "ArrowDown":
      return { key: "arrowDown" };
    case "Backspace":
      return { key: "backspace" };
    case "Escape":
      return { key: "escape" };
    case "Home":
      return { key: "home" };
    case "End":
      return { key: "end" };
    default: {
      const characters = Array.from(event.key);
      if (characters.length !== 1) {
        return undefined;
      }
      return {
        key: "character",
        character: characters[0],
      };
    }
  }
}

function pointerButton(button: number): PointerButton {
  switch (button) {
    case 1:
      return "middle";
    case 2:
      return "secondary";
    default:
      return "primary";
  }
}

function modifierMask(event: MouseEvent | KeyboardEvent): number {
  let mask = 0;
  if (event.shiftKey) {
    mask |= 1;
  }
  if (event.altKey) {
    mask |= 2;
  }
  if (event.ctrlKey) {
    mask |= 4;
  }
  return mask;
}

/**
 * One axis of a wheel's travel in (fractional) cells. Pixel mode, and any
 * unrecognized mode, divides by the cell pitch; a pitch that is not a finite
 * positive number falls back to one cell in the delta's direction.
 */
function wheelTravel(
  delta: number,
  mode: number,
  pitch: number,
  extent: number,
): number {
  if (!Number.isFinite(delta) || delta === 0) {
    return 0;
  }
  switch (mode) {
    case DOM_DELTA_LINE:
      return delta;
    case DOM_DELTA_PAGE:
      return delta * (Number.isFinite(extent) && extent >= 1 ? extent : 1);
    default:
      return Number.isFinite(pitch) && pitch > 0
        ? delta / pitch
        : Math.sign(delta);
  }
}

/**
 * Adds `travel` to the carried sub-cell `remainder` and splits the total into
 * the whole cells to send now (bounded by {@link MAX_WHEEL_CELL_DELTA}) and the
 * remainder to carry. A reversal drops the opposing remainder; a clamped total
 * carries nothing.
 */
function wholeWheelCells(remainder: number, travel: number): [number, number] {
  const carried =
    travel !== 0 && Math.sign(travel) !== Math.sign(remainder) ? 0 : remainder;
  const total = carried + travel;
  const whole = Math.trunc(total);
  if (Math.abs(whole) > MAX_WHEEL_CELL_DELTA) {
    return [Math.sign(whole) * MAX_WHEEL_CELL_DELTA, 0];
  }
  // `|| 0` normalizes -0 so a record never spells a negative zero.
  return [whole || 0, total - whole];
}
