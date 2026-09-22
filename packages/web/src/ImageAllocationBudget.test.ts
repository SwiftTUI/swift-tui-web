import { expect, test } from "bun:test";
import { admitsImageBytes, admitsImagePayload } from "./ImageAllocationBudget.ts";

test("PNG dimensions are checked before compressed bitmap decode", () => {
  const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5L8AAAAASUVORK5CYII="), c => c.charCodeAt(0));
  expect(admitsImageBytes(bytes)).toBe(true);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 8192);
  view.setUint32(20, 2048);
  expect(admitsImageBytes(bytes)).toBe(true);
  view.setUint32(20, 2049);
  expect(admitsImageBytes(bytes)).toBe(false);
  view.setUint32(16, 0xffffffff);
  expect(admitsImageBytes(bytes)).toBe(false);
});

test("GIF and JPEG dimensions and truncated headers stay bounded", () => {
  const gif = Uint8Array.of(71, 73, 70, 56, 57, 97, 1, 0, 1, 0);
  expect(admitsImageBytes(gif)).toBe(true);
  gif[7] = 255;
  expect(admitsImageBytes(gif)).toBe(false);
  const jpeg = Uint8Array.of(255, 216, 255, 192, 0, 8, 8, 0, 1, 0, 1, 0);
  expect(admitsImageBytes(jpeg)).toBe(true);
  jpeg[7] = 255;
  expect(admitsImageBytes(jpeg)).toBe(false);
  for (let count = 0; count < jpeg.length; count++) {
    expect(admitsImageBytes(jpeg.subarray(0, count))).toBe(false);
  }
  expect(admitsImagePayload("QUJD")).toBe(false);
  expect(admitsImagePayload("%%%not-base64")).toBe(false);
});
