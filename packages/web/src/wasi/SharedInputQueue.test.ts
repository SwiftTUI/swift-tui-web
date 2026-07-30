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

    // The synchronous `write` still refuses what cannot fit in one go — it is
    // the worker-side, non-suspending entry point. `writeAsync` is the
    // main-thread path that streams it instead; see the tests below.
    expect(() => writer.write(firstOverflowingRecord)).toThrow(
      `Shared input queue overflow: cannot enqueue ${characterization.firstOverflowingRecordBytes} byte(s) into ${sharedInputQueueDefaultCapacity} byte(s) of free space.`
    );
    expect(reader.availableBytes()).toBe(0);
  }
});

test("writeAsync streams a paste larger than the ring, in order", async () => {
  for (const bytes of [
    // 128 KiB of ASCII and 64 KiB of CJK: two records each larger than the
    // 64 KiB ring, one of them by 2x.
    encodePasteInputMessage("a".repeat(128 * 1024)),
    encodePasteInputMessage("界".repeat(64 * 1024 / 3)),
  ]) {
    expect(bytes.byteLength).toBeGreaterThan(sharedInputQueueDefaultCapacity);

    const queue = createSharedInputQueue();
    const writer = new SharedInputQueueWriter(queue);
    const reader = new SharedInputQueueReader(queue);

    // A deliberately slow reader: 4 KiB per turn, so the write suspends many
    // times before completing.
    const received: number[] = [];
    const write = writer.writeAsync(bytes);
    for (let turn = 0; turn < 4_096 && received.length < bytes.byteLength; turn += 1) {
      const chunk = reader.readAvailable(4 * 1024);
      if (chunk) {
        received.push(...chunk);
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    }

    expect(await write).toEqual({ status: "written" });
    expect(new Uint8Array(received)).toEqual(bytes);
  }
});

test("writeAsync preserves order across concurrent logical writes", async () => {
  const queue = createSharedInputQueue();
  const writer = new SharedInputQueueWriter(queue);
  const reader = new SharedInputQueueReader(queue);

  // The first write cannot fit, so it suspends mid-record. A small write issued
  // while it is still pending must queue behind it — with free space available
  // it would otherwise take the synchronous fast path and land *inside* the
  // first record, splitting one paste into two and corrupting both.
  const first = encodePasteInputMessage("a".repeat(96 * 1024));
  const second = encodePasteInputMessage("b");
  const firstWrite = writer.writeAsync(first);

  const received: number[] = [];
  // Free some space so a fast-path write would fit, then issue the small one.
  received.push(...(reader.readAvailable(8 * 1024) ?? []));
  const secondWrite = writer.writeAsync(second);
  expect(writer.availableCapacity()).toBeGreaterThan(second.byteLength);

  const total = first.byteLength + second.byteLength;
  for (let turn = 0; turn < 4_096 && received.length < total; turn += 1) {
    const chunk = reader.readAvailable(8 * 1024);
    if (chunk) {
      received.push(...chunk);
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }

  expect(await Promise.all([firstWrite, secondWrite])).toEqual([
    { status: "written" },
    { status: "written" },
  ]);
  expect(new Uint8Array(received)).toEqual(
    new Uint8Array([...first, ...second])
  );
});

test("writeAsync reports a partial write once its deadline expires", async () => {
  const queue = createSharedInputQueue();
  const writer = new SharedInputQueueWriter(queue);
  const bytes = encodePasteInputMessage("a".repeat(96 * 1024));

  // A reader that never drains, and an injected clock that jumps past the
  // 500 ms budget: bounded by the deadline, not by wall time.
  let clock = 0;
  const outcome = await writer.writeAsync(bytes, {
    deadlineMilliseconds: 500,
    now: () => {
      clock += 250;
      return clock;
    },
  });

  expect(outcome.status).toBe("partial");
  if (outcome.status !== "partial") {
    throw new Error("expected a partial write");
  }
  // Everything that fit was delivered; only the remainder was dropped.
  expect(outcome.bytesWritten).toBe(sharedInputQueueDefaultCapacity);
  expect(outcome.bytesRemaining).toBe(
    bytes.byteLength - sharedInputQueueDefaultCapacity
  );
});

test("writeAsync stops when the queue closes mid-write", async () => {
  const queue = createSharedInputQueue();
  const writer = new SharedInputQueueWriter(queue);
  const bytes = encodePasteInputMessage("a".repeat(96 * 1024));

  const write = writer.writeAsync(bytes);
  writer.close();
  const outcome = await write;

  expect(outcome.status).toBe("closed");
});

test("the main-thread writer never blocks on Atomics.wait", async () => {
  // A structural guard, because the failure mode is a frozen tab rather than a
  // wrong value: blocking on the main thread throws in browsers, and a test
  // that only checked outputs would not see the difference.
  const source = await Bun.file(
    new URL("./SharedInputQueue.ts", import.meta.url)
  ).text();
  const writerSource = source.slice(
    source.indexOf("export class SharedInputQueueWriter"),
    source.indexOf("export class SharedInputQueueReader")
  );
  expect(writerSource).not.toContain("Atomics.wait(");
  expect(writerSource).toContain("Atomics.waitAsync");
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
