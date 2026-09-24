import { expect, test } from "bun:test";
import { firstGifFrame, staticGifBase64 } from "./StaticGif.ts";

// Two authored 1px frames: red, then blue, with a looping application block.
const header = [
  71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, 255, 0, 0, 0, 0, 255,
];
const loop = [
  33,
  255,
  11,
  ...new TextEncoder().encode("NETSCAPE2.0"),
  3,
  1,
  0,
  0,
  0,
];
const frame = [
  33, 249, 4, 0, 5, 0, 0, 0, 44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 68, 1, 0,
];
test("raw GIF retains only the first selected frame and drops its independent animation clock", () => {
  const second = [...frame];
  second[20] = 76;
  const animated = new Uint8Array([
    ...header,
    ...loop,
    ...frame,
    ...second,
    59,
  ]);
  const expected = new Uint8Array([...header, ...frame, 59]);
  expect(firstGifFrame(animated)).toEqual(expected);
  const payload = btoa(String.fromCharCode(...animated));
  expect(staticGifBase64(payload)).toBe(btoa(String.fromCharCode(...expected)));
});
test("truncated palettes, missing terminators and oversized frame descriptors are rejected", () => {
  const valid = new Uint8Array([...header, ...frame, 59]);
  for (let length = 0; length < valid.length - 1; length++)
    expect(() => firstGifFrame(valid.slice(0, length))).toThrow();
  const oversize = valid.slice();
  oversize[header.length + 13] = 255;
  expect(() => firstGifFrame(oversize)).toThrow();
});
