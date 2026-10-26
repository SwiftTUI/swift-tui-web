import { expect, test } from "bun:test";
import { InputEventEncoder } from "./InputEventEncoder.ts";

const encoder = new InputEventEncoder();
const text = (bytes: Uint8Array | undefined) =>
  bytes === undefined ? undefined : new TextDecoder().decode(bytes);
const key = (value: string, flags: Partial<KeyboardEvent> = {}) =>
  ({ key: value, ...flags }) as KeyboardEvent;
const pointer = (flags: Partial<PointerEvent> = {}) => flags as PointerEvent;

for (let id = 71; id <= 90; id++) {
  test(`w1s${String(id).padStart(3, "0")} input wire translation contract`, () => {
    switch (id) {
      case 71:
        expect(text(encoder.encodeKey(key("Enter")))).toBe(
          "\x1ekey:return:0\n",
        );
        break;
      case 72:
        expect(text(encoder.encodeKey(key(" ")))).toBe("\x1ekey:space:0\n");
        break;
      case 73:
        expect(text(encoder.encodeKey(key("Tab", { shiftKey: true })))).toBe(
          "\x1ekey:tab:1\n",
        );
        break;
      case 74:
        expect(
          text(encoder.encodeKey(key("ArrowLeft", { ctrlKey: true }))),
        ).toBe("\x1ekey:arrowLeft:4\n");
        break;
      case 75:
        expect(text(encoder.encodeKey(key("Home")))).toBe("\x1ekey:home:0\n");
        expect(text(encoder.encodeKey(key("End")))).toBe("\x1ekey:end:0\n");
        break;
      case 76:
        expect(
          text(encoder.encodeKey(key("Backspace", { altKey: true }))),
        ).toBe("\x1ekey:backspace:2\n");
        break;
      case 77:
        expect(text(encoder.encodeKey(key("Escape")))).toBe(
          "\x1ekey:escape:0\n",
        );
        break;
      case 78:
        expect(text(encoder.encodeKey(key("a")))).toBe(
          "\x1ekey:character:a:0\n",
        );
        break;
      case 79:
        expect(text(encoder.encodeKey(key("😀")))).toBe(
          "\x1ekey:character:%F0%9F%98%80:0\n",
        );
        break;
      case 80:
        expect(encoder.encodeKey(key("e\u0301"))).toBeUndefined();
        break;
      case 81:
        expect(encoder.encodeKey(key("F1"))).toBeUndefined();
        break;
      case 82:
        expect(
          text(
            encoder.encodeKey(
              key("z", { shiftKey: true, altKey: true, ctrlKey: true }),
            ),
          ),
        ).toBe("\x1ekey:character:z:7\n");
        break;
      case 83:
        expect(text(encoder.encodePaste("a\n界:😀"))).toBe(
          "\x1epaste:a%0A%E7%95%8C%3A%F0%9F%98%80\n",
        );
        break;
      case 84:
        expect(
          text(
            encoder.encodePointerDown(
              { x: 1.5, y: 2.25 },
              "middle",
              pointer({ shiftKey: true }),
              3,
              4,
            ),
          ),
        ).toBe("\x1emouseViewport:3:4:down:1.5:2.25:middle:0:0:1\n");
        break;
      case 85:
        expect(
          text(encoder.encodePointerUp({ x: 1, y: 2 }, "secondary", pointer())),
        ).toBe("\x1emouse:up:1:2:secondary:0:0:0\n");
        break;
      case 86:
        expect(text(encoder.encodePointerCancel({ x: -1, y: 12 }, 3))).toBe(
          "\x1emouseGeometry:3:cancelled:-1:12:none:0:0:0\n",
        );
        break;
      case 87:
        expect(
          text(
            encoder.encodePointerMove(
              { x: 1, y: 2 },
              "primary",
              pointer({ buttons: 0 }),
            ),
          ),
        ).toBe("\x1emouse:moved:1:2:primary:0:0:0\n");
        break;
      case 88:
        expect(
          text(
            encoder.encodePointerMove(
              { x: 1, y: 2 },
              "primary",
              pointer({ buttons: 1 }),
            ),
          ),
        ).toBe("\x1emouse:dragged:1:2:primary:0:0:0\n");
        break;
      case 89: {
        // STUI-1191 (wave 3): pixel deltas become whole cells of the given
        // pitch, sub-cell travel carries, each axis is bounded to 16 cells,
        // and a wheel without a whole cell sends no record.
        const wheelEncoder = new InputEventEncoder();
        const metrics = {
          cellWidth: 10,
          cellHeight: 20,
          columns: 80,
          rows: 24,
        };
        for (const [dx, dy, expected] of [
          [0.1, -40, "0:-2"],
          [-0.1, 400, "0:16"],
          [0, 0, undefined],
        ] as const) {
          const wheel = { deltaX: dx, deltaY: dy, deltaMode: 0 } as WheelEvent;
          expect(
            text(wheelEncoder.encodeWheel({ x: 1, y: 2 }, wheel, metrics)),
          ).toBe(
            expected === undefined
              ? undefined
              : `\x1emouse:scrolled:1:2:none:${expected}:0\n`,
          );
        }
        break;
      }
      case 90:
        expect(
          [0, 1, 2].map((button) => encoder.pointerButton(button)),
        ).toEqual(["primary", "middle", "secondary"]);
        break;
    }
  });
}

// Wave 4 neighbour for STUI-1275 (w4web-n03): the carry is kept in the device
// unit of the wheel that left it, and a pitch change between wheels (a resize
// or font change) rescales it as the same fraction of a cell.
test("a pitch change between wheels keeps the carried fraction of a cell (w4web-n03)", () => {
  const wheelEncoder = new InputEventEncoder();
  const wheel = { deltaX: 0, deltaY: 0, deltaMode: 0 } as WheelEvent;
  const metrics = (cellHeight: number) => ({
    cellWidth: 10,
    cellHeight,
    columns: 80,
    rows: 24,
  });
  expect(
    text(
      wheelEncoder.encodeWheel(
        { x: 1, y: 2 },
        { ...wheel, deltaY: 13.5 },
        metrics(27),
      ),
    ),
  ).toBeUndefined();
  expect(
    text(
      wheelEncoder.encodeWheel(
        { x: 1, y: 2 },
        { ...wheel, deltaY: 10 },
        metrics(20),
      ),
    ),
  ).toBe("\x1emouse:scrolled:1:2:none:0:1:0\n");
});
