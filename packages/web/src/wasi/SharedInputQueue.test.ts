import { expect, test } from "bun:test";
import { Worker } from "node:worker_threads";

import {
  SharedInputQueueReader,
  SharedInputQueueWriter,
  type SharedInputQueueBuffers,
  createSharedInputQueue,
  sharedInputQueueDefaultCapacity,
} from "./SharedInputQueue.ts";
import { encodePasteInputMessage } from "../WebHostSurfaceTransport.ts";

const pasteOverflowCharacterizations = [
  {
    label: "ASCII",
    character: "a",
    maximumFittingCharacters: 65_528,
    maximumFittingRecordBytes: 65_536,
    firstOverflowingCharacters: 65_529,
    firstOverflowingRecordBytes: 65_537,
  },
  {
    label: "CJK",
    character: "界",
    maximumFittingCharacters: 7_280,
    maximumFittingRecordBytes: 65_528,
    firstOverflowingCharacters: 7_281,
    firstOverflowingRecordBytes: 65_537,
  },
] as const;

test("shared input queue preserves write order across partial reads", () => {
  const queue = createSharedInputQueue(8);
  const writer = new SharedInputQueueWriter(queue);
  const reader = new SharedInputQueueReader(queue);

  writer.write("abcdef");

  expect(decode(reader.readAvailable(2))).toBe("ab");
  expect(decode(reader.readAvailable(4))).toBe("cdef");
  expect(reader.readAvailable(4)).toBeUndefined();
});

test("shared input queue retains the legacy three-word control-buffer ABI", () => {
  const queue = {
    controlBuffer: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 3),
    dataBuffer: new SharedArrayBuffer(8),
  };
  const writer = new SharedInputQueueWriter(queue);
  const reader = new SharedInputQueueReader(queue);

  expect(createSharedInputQueue(8).controlBuffer.byteLength).toBe(
    Int32Array.BYTES_PER_ELEMENT * 3
  );
  writer.write("legacy");
  expect(decode(reader.readAvailable(8))).toBe("legacy");
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

test("writer capacity wait resolves when the reader drains enough bytes", async () => {
  const queue = createSharedInputQueue(8);
  const writer = new SharedInputQueueWriter(queue);
  const reader = new SharedInputQueueReader(queue);
  writer.write(new Uint8Array(8));

  const capacity = writer.waitForCapacity(4);
  reader.readAvailable(4);

  expect(await capacity).toBe(true);
  expect(writer.availableCapacity()).toBe(4);
});

test("writer capacity wait cannot lose a drain between snapshot and recheck", async () => {
  const queue = createSharedInputQueue(8);
  const writer = new SharedInputQueueWriter(queue);
  const reader = new SharedInputQueueReader(queue);
  writer.write(new Uint8Array(8));

  const availableCapacity = writer.availableCapacity.bind(writer);
  let injectedDrain = false;
  writer.availableCapacity = (): number => {
    if (!injectedDrain) {
      injectedDrain = true;
      reader.readAvailable(4);
      // Model the stale capacity result that raced with the drain. The
      // pre-recheck read-index snapshot makes waitAsync return not-equal.
      return 0;
    }
    return availableCapacity();
  };

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    writer.waitForCapacity(4),
    new Promise<"timedOut">((resolve) => {
      timeout = setTimeout(() => resolve("timedOut"), 250);
    }),
  ]);
  clearTimeout(timeout);
  expect(injectedDrain).toBe(true);
  expect(result).toBe(true);
});

test("writer capacity wait cannot lose close during condition recheck", async () => {
  const queue = createSharedInputQueue(8);
  const writer = new SharedInputQueueWriter(queue);
  writer.write(new Uint8Array(8));

  let injectedClose = false;
  writer.availableCapacity = (): number => {
    if (!injectedClose) {
      injectedClose = true;
      writer.close();
    }
    return 0;
  };

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const result = await Promise.race([
    writer.waitForCapacity(4),
    new Promise<"timedOut">((resolve) => {
      timeout = setTimeout(() => resolve("timedOut"), 250);
    }),
  ]);
  clearTimeout(timeout);
  expect(injectedClose).toBe(true);
  expect(result).toBe(false);
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

test("characterization: percent-encoded paste records overflow at the pinned 64 KiB boundaries", () => {
  expect(sharedInputQueueDefaultCapacity).toBe(65_536);

  for (const characterization of pasteOverflowCharacterizations) {
    const queue = createSharedInputQueue();
    const writer = new SharedInputQueueWriter(queue);
    const reader = new SharedInputQueueReader(queue);
    const maximumFittingRecord = encodePasteInputMessage(
      characterization.character.repeat(characterization.maximumFittingCharacters)
    );
    const firstOverflowingRecord = encodePasteInputMessage(
      characterization.character.repeat(characterization.firstOverflowingCharacters)
    );

    expect(maximumFittingRecord.byteLength).toBe(
      characterization.maximumFittingRecordBytes
    );
    expect(firstOverflowingRecord.byteLength).toBe(
      characterization.firstOverflowingRecordBytes
    );

    writer.write(maximumFittingRecord);
    expect(reader.availableBytes()).toBe(
      characterization.maximumFittingRecordBytes
    );
    reader.readAvailable(sharedInputQueueDefaultCapacity);
    expect(reader.availableBytes()).toBe(0);

    // Known defect D13: the writer rejects the entire input record rather
    // than applying backpressure or streaming it in bounded chunks.
    expect(() => writer.write(firstOverflowingRecord)).toThrow(
      `Shared input queue overflow: cannot enqueue ${characterization.firstOverflowingRecordBytes} byte(s) into ${sharedInputQueueDefaultCapacity} byte(s) of free space.`
    );
    expect(reader.availableBytes()).toBe(0);
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
