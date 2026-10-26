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
 * One axis of wheel travel in the device unit of the wheel that produced it:
 * CSS pixels for pixel deltas, cells for line and page deltas (a line is one
 * cell and a page is the presented grid).
 */
interface WheelTravel {
  /** Travel in device units. */
  travel: number;
  /** Device units in one cell: the presented pitch for pixels, else 1. */
  unitsPerCell: number;
}

const noWheelTravel: WheelTravel = { travel: 0, unitsPerCell: 1 };

/**
 * Encodes DOM keyboard/pointer/wheel/paste events into the `web-surface` wire
 * messages the SwiftTUI host consumes. This collaborator owns the translation
 * from browser event vocabulary (key names, button indices, wheel deltas,
 * modifier flags) to the transport's message vocabulary; it produces raw byte
 * chunks and holds no DOM or geometry state. Its only state is the sub-cell
 * wheel travel (under one cell per axis) carried to the next wheel event, kept
 * in the device unit of the wheel that left it so that travel adding up to an
 * exact multiple of the pitch sends that cell on the wheel that completes it.
 *
 * Hit-testing (pixel → cell) lives in the host, which passes already-resolved
 * {@link CellLocation}s and {@link WheelCellMetrics} here so the encoder stays
 * free of layout concerns.
 */
export class InputEventEncoder {
  private wheelCarryX = noWheelTravel;
  private wheelCarryY = noWheelTravel;

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
   * {@link MAX_WHEEL_CELL_DELTA}: when the carried and new travel exceed it,
   * the record carries the bound and nothing is carried. Returns `undefined`
   * when neither axis has reached a whole cell; the host still consumes the
   * event.
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
    const [deltaX, carryX] = wholeWheelCells(
      this.wheelCarryX,
      wheelTravel(event.deltaX, mode, metrics.cellWidth, metrics.columns),
    );
    const [deltaY, carryY] = wholeWheelCells(
      this.wheelCarryY,
      wheelTravel(event.deltaY, mode, metrics.cellHeight, metrics.rows),
    );
    this.wheelCarryX = carryX;
    this.wheelCarryY = carryY;
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

  /**
   * Applies the reversal rule to a wheel the host sees but does not forward
   * (Ctrl/Command+wheel left to the browser, passive mode, a pointer outside
   * the grid, a chain-mode fall-through): a delta opposing an axis's carried
   * travel drops that carry. The wheel adds no travel, and a carry in its own
   * direction stays.
   */
  observeUnforwardedWheel(event: WheelEvent): void {
    this.wheelCarryX = droppingReversedCarry(this.wheelCarryX, event.deltaX);
    this.wheelCarryY = droppingReversedCarry(this.wheelCarryY, event.deltaY);
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
 * One axis of a wheel's travel in its device unit, or `undefined` for no
 * travel. Pixel mode, and any unrecognized mode, counts CSS pixels against the
 * cell pitch; line and page deltas count cells. A pitch that is not a finite
 * positive number falls back to one cell in the delta's direction.
 */
function wheelTravel(
  delta: number,
  mode: number,
  pitch: number,
  extent: number,
): WheelTravel | undefined {
  if (!Number.isFinite(delta) || delta === 0) {
    return undefined;
  }
  switch (mode) {
    case DOM_DELTA_LINE:
      return { travel: delta, unitsPerCell: 1 };
    case DOM_DELTA_PAGE:
      return {
        travel: delta * (Number.isFinite(extent) && extent >= 1 ? extent : 1),
        unitsPerCell: 1,
      };
    default:
      return Number.isFinite(pitch) && pitch > 0
        ? { travel: delta, unitsPerCell: pitch }
        : { travel: Math.sign(delta), unitsPerCell: 1 };
  }
}

/**
 * Adds `next` to the carried sub-cell travel and splits the total into the
 * whole cells to send now and the remainder to carry, both in `next`'s unit.
 * A reversal drops the carry first; a carry in another unit (a mode change, or
 * a pitch change after a resize) keeps its fraction of a cell. A total beyond
 * {@link MAX_WHEEL_CELL_DELTA} cells sends the bound and carries nothing.
 */
function wholeWheelCells(
  carry: WheelTravel,
  next: WheelTravel | undefined,
): [number, WheelTravel] {
  if (!next) return [0, carry];
  const unit = next.unitsPerCell;
  const kept = droppingReversedCarry(carry, next.travel);
  const carried =
    kept.unitsPerCell === unit
      ? kept.travel
      : (kept.travel / kept.unitsPerCell) * unit;
  const total = carried + next.travel;
  // Scaling by 16 is exact, so the bound applies to the travel itself rather
  // than to its truncation.
  if (Math.abs(total) > MAX_WHEEL_CELL_DELTA * unit) {
    return [
      Math.sign(total) * MAX_WHEEL_CELL_DELTA,
      { travel: 0, unitsPerCell: unit },
    ];
  }
  // `%` is exact, so travel that sums to a whole number of cells carries
  // nothing and sends them now.
  const remainder = total % unit;
  // `|| 0` normalizes -0 so a record never spells a negative zero.
  const whole = Math.round((total - remainder) / unit) || 0;
  return [whole, { travel: remainder, unitsPerCell: unit }];
}

/** Drops `carry` when `delta` travels the other way. */
function droppingReversedCarry(carry: WheelTravel, delta: number): WheelTravel {
  return Number.isFinite(delta) &&
    delta !== 0 &&
    Math.sign(delta) !== Math.sign(carry.travel)
    ? { travel: 0, unitsPerCell: carry.unitsPerCell }
    : carry;
}
