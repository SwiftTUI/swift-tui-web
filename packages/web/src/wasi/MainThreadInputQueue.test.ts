import { expect, test } from "bun:test";

import { MainThreadInputQueue } from "./MainThreadInputQueue.ts";

test("queue round-trips chunks including partial reads", () => {
  const queue = new MainThreadInputQueue();
  queue.write(new Uint8Array([1, 2, 3, 4]));
  expect(queue.availableBytes()).toBe(4);

  expect(Array.from(queue.readAvailable(2) ?? [])).toEqual([1, 2]);
  expect(queue.availableBytes()).toBe(2);
  expect(Array.from(queue.readAvailable(8) ?? [])).toEqual([3, 4]);
  expect(queue.readAvailable(8)).toBeUndefined();
});

test("waitForReadableAsync resolves readable on write", async () => {
  const queue = new MainThreadInputQueue();
  const readiness = queue.waitForReadableAsync();
  queue.write(new Uint8Array([7]));
  expect(await readiness).toBe("readable");
});

test("waitForReadableAsync resolves closed on close", async () => {
  const queue = new MainThreadInputQueue();
  const readiness = queue.waitForReadableAsync();
  queue.close();
  expect(await readiness).toBe("closed");
});

test("waitForReadableAsync times out", async () => {
  const queue = new MainThreadInputQueue();
  expect(await queue.waitForReadableAsync(10)).toBe("timedOut");
});

test("close drains pending data before reporting closed", () => {
  const queue = new MainThreadInputQueue();
  queue.write(new Uint8Array([1]));
  queue.close();
  expect(queue.isClosed()).toBe(false);
  expect(Array.from(queue.readAvailable(4) ?? [])).toEqual([1]);
  expect(queue.isClosed()).toBe(true);
  queue.write(new Uint8Array([2]));
  expect(queue.availableBytes()).toBe(0);
});
