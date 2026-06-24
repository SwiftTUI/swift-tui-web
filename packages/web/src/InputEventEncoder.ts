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
 * Encodes DOM keyboard/pointer/wheel/paste events into the `web-surface` wire
 * messages the SwiftTUI host consumes. This collaborator owns the translation
 * from browser event vocabulary (key names, button indices, wheel deltas,
 * modifier flags) to the transport's message vocabulary; it produces raw byte
 * chunks and holds no DOM or geometry state.
 *
 * Hit-testing (pixel → cell) lives in the host, which passes already-resolved
 * {@link CellLocation}s here so the encoder stays free of layout concerns.
 */
export class InputEventEncoder {
  /**
   * Builds the key message for a keyboard event, or `undefined` when the event
   * does not map to a forwarded key (e.g. a multi-codepoint composed string).
   * Returning `undefined` lets the host leave the event unhandled.
   */
  encodeKey(
    event: KeyboardEvent
  ): Uint8Array | undefined {
    const key = keyInputFromKeyboardEvent(event);
    if (!key) {
      return undefined;
    }
    return encodeKeyInputMessage({
      ...key,
      modifiers: modifierMask(event),
    });
  }

  encodePaste(
    text: string
  ): Uint8Array {
    return encodePasteInputMessage(text);
  }

  encodePointerDown(
    location: CellLocation,
    button: PointerButton,
    event: PointerEvent
  ): Uint8Array {
    return encodeMouseInputMessage({
      kind: "down",
      x: location.x,
      y: location.y,
      button,
      modifiers: modifierMask(event),
    });
  }

  encodePointerUp(
    location: CellLocation,
    button: PointerButton,
    event: PointerEvent
  ): Uint8Array {
    return encodeMouseInputMessage({
      kind: "up",
      x: location.x,
      y: location.y,
      button,
      modifiers: modifierMask(event),
    });
  }

  encodePointerMove(
    location: CellLocation,
    button: PointerButton,
    event: PointerEvent
  ): Uint8Array {
    return encodeMouseInputMessage({
      kind: event.buttons ? "dragged" : "moved",
      x: location.x,
      y: location.y,
      button,
      modifiers: modifierMask(event),
    });
  }

  encodeWheel(
    location: CellLocation,
    event: WheelEvent
  ): Uint8Array {
    return encodeMouseInputMessage({
      kind: "scrolled",
      x: location.x,
      y: location.y,
      deltaX: normalizedWheelDelta(event.deltaX),
      deltaY: normalizedWheelDelta(event.deltaY),
      modifiers: modifierMask(event),
    });
  }

  /** Translates a DOM `MouseEvent.button` index into the wire button identity. */
  pointerButton(
    button: number
  ): PointerButton {
    return pointerButton(button);
  }
}

function keyInputFromKeyboardEvent(
  event: KeyboardEvent
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
  default:
    {
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

function pointerButton(
  button: number
): PointerButton {
  switch (button) {
  case 1:
    return "middle";
  case 2:
    return "secondary";
  default:
    return "primary";
  }
}

function modifierMask(
  event: MouseEvent | KeyboardEvent
): number {
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

function normalizedWheelDelta(
  delta: number
): number {
  if (delta > 0) {
    return 1;
  }
  if (delta < 0) {
    return -1;
  }
  return 0;
}
