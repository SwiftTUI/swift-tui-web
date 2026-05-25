import { expect, test } from "bun:test";
import { Worker } from "node:worker_threads";

import {
  SharedInputQueueReader,
  SharedInputQueueWriter,
  type SharedInputQueueBuffers,
  createSharedInputQueue,
} from "./SharedInputQueue.ts";

test("shared input queue preserves write order across partial reads", () => {
  const queue = createSharedInputQueue(8);
  const writer = new SharedInputQueueWriter(queue);
  const reader = new SharedInputQueueReader(queue);

  writer.write("abcdef");

  expect(decode(reader.readAvailable(2))).toBe("ab");
  expect(decode(reader.readAvailable(4))).toBe("cdef");
  expect(reader.readAvailable(4)).toBeUndefined();
});

test("shared input queue wraps around the ring buffer", () => {
  const queue = createSharedInputQueue(8);
  const writer = new SharedInputQueueWriter(queue);
  const reader = new SharedInputQueueReader(queue);

  writer.write("abcdef");
  expect(decode(reader.readAvailable(4))).toBe("abcd");

  writer.write("gh");
  expect(decode(reader.readAvailable(4))).toBe("efgh");
  expect(reader.readAvailable(4)).toBeUndefined();
});

test("shared input queue reports EOF after close once buffered data is drained", () => {
  const queue = createSharedInputQueue(8);
  const writer = new SharedInputQueueWriter(queue);
  const reader = new SharedInputQueueReader(queue);

  writer.write("ok");
  writer.close();

  expect(decode(reader.readAvailable(8))).toBe("ok");
  expect(reader.readAvailable(8)).toBeUndefined();
  expect(reader.read(8)).toBeUndefined();
});

test("shared input queue reports readable bytes without consuming them", () => {
  const queue = createSharedInputQueue(8);
  const writer = new SharedInputQueueWriter(queue);
  const reader = new SharedInputQueueReader(queue);

  expect(reader.availableBytes()).toBe(0);

  writer.write("abc");

  expect(reader.availableBytes()).toBe(3);
  expect(decode(reader.readAvailable(2))).toBe("ab");
  expect(reader.availableBytes()).toBe(1);
});

test("shared input queue timed readiness wait wakes on write", async () => {
  const queue = createSharedInputQueue(8);
  const reader = new SharedInputQueueReader(queue);
  const worker = writeInputFromWorker(queue, "x", 10);

  try {
    expect(reader.waitForReadable(250)).toBe("readable");
    expect(decode(reader.readAvailable(1))).toBe("x");
  } finally {
    await worker.terminate();
  }
});

test("shared input queue timed readiness wait returns timedOut", () => {
  const queue = createSharedInputQueue(8);
  const reader = new SharedInputQueueReader(queue);

  expect(reader.waitForReadable(1)).toBe("timedOut");
});

test("shared input queue readiness wait wakes on close", async () => {
  const queue = createSharedInputQueue(8);
  const reader = new SharedInputQueueReader(queue);
  const worker = closeInputFromWorker(queue, 10);

  try {
    expect(reader.waitForReadable(250)).toBe("closed");
  } finally {
    await worker.terminate();
  }
});

function decode(
  chunk: Uint8Array | undefined
): string | undefined {
  return chunk ? new TextDecoder().decode(chunk) : undefined;
}

function writeInputFromWorker(
  queue: SharedInputQueueBuffers,
  text: string,
  delayMilliseconds: number
): Worker {
  return new Worker(`
    const { workerData } = require("node:worker_threads");
    const control = new Int32Array(workerData.controlBuffer);
    const data = new Uint8Array(workerData.dataBuffer);
    const bytes = new TextEncoder().encode(workerData.text);
    setTimeout(() => {
      const writeIndex = Atomics.load(control, 1);
      data.set(bytes, writeIndex % data.length);
      Atomics.store(control, 1, writeIndex + bytes.length);
      Atomics.notify(control, 1);
    }, workerData.delayMilliseconds);
  `, {
    eval: true,
    workerData: {
      controlBuffer: queue.controlBuffer,
      dataBuffer: queue.dataBuffer,
      delayMilliseconds,
      text,
    },
  });
}

function closeInputFromWorker(
  queue: SharedInputQueueBuffers,
  delayMilliseconds: number
): Worker {
  return new Worker(`
    const { workerData } = require("node:worker_threads");
    const control = new Int32Array(workerData.controlBuffer);
    setTimeout(() => {
      Atomics.store(control, 2, 1);
      Atomics.notify(control, 1);
    }, workerData.delayMilliseconds);
  `, {
    eval: true,
    workerData: {
      controlBuffer: queue.controlBuffer,
      delayMilliseconds,
    },
  });
}
