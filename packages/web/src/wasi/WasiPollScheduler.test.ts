import { expect, test } from "bun:test";
import { Worker } from "node:worker_threads";
import { wasi } from "@bjorn3/browser_wasi_shim";

import {
  SharedInputQueueReader,
  type SharedInputQueueBuffers,
  createSharedInputQueue,
} from "./SharedInputQueue.ts";
import { MainThreadInputQueue } from "./MainThreadInputQueue.ts";
import {
  SuspendingWasiPollScheduler,
  WasiPollScheduler,
  type WasiPollReadableSource,
  readPollEventsForTesting,
  writeClockSubscriptionForTesting,
  writeFdReadSubscriptionForTesting,
} from "./WasiPollScheduler.ts";

test("scheduler completes a relative monotonic clock subscription", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const view = new DataView(memory.buffer);
  writeClockSubscriptionForTesting(view, 0, {
    userdata: 1n,
    timeoutNanoseconds: 1_000_000n,
  });

  const scheduler = new WasiPollScheduler({
    memory: () => memory,
    stdin: closedSource(),
    fallbackPoll: () => wasi.ERRNO_INVAL,
  });

  expect(scheduler.pollOneOff(0, 128, 1, 256)).toBe(wasi.ERRNO_SUCCESS);
  expect(readPollEventsForTesting(view, 128, 1)).toEqual([
    { userdata: 1n, errno: wasi.ERRNO_SUCCESS, eventtype: wasi.EVENTTYPE_CLOCK },
  ]);
  expect(view.getUint32(256, true)).toBe(1);
});

test("scheduler wakes stdin-only poll on stdin readability", async () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const view = new DataView(memory.buffer);
  const queue = createSharedInputQueue(8);
  const reader = new SharedInputQueueReader(queue);
  const worker = writeInputFromWorker(queue, "x", 10);

  writeFdReadSubscriptionForTesting(view, 0, { userdata: 10n, fd: 0 });

  const scheduler = new WasiPollScheduler({
    memory: () => memory,
    stdin: reader,
    fallbackPoll: () => wasi.ERRNO_INVAL,
  });

  try {
    expect(scheduler.pollOneOff(0, 128, 1, 256)).toBe(wasi.ERRNO_SUCCESS);
    expect(readPollEventsForTesting(view, 128, 1)).toEqual([
      { userdata: 10n, errno: wasi.ERRNO_SUCCESS, eventtype: wasi.EVENTTYPE_FD_READ },
    ]);
    expect(view.getBigUint64(128 + 16, true)).toBe(1n);
    expect(view.getUint16(128 + 24, true)).toBe(0);
    expect(view.getUint32(256, true)).toBe(1);
  } finally {
    await worker.terminate();
  }
});

test("scheduler wakes mixed stdin and clock poll on stdin readability", async () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const view = new DataView(memory.buffer);
  const queue = createSharedInputQueue(8);
  const reader = new SharedInputQueueReader(queue);
  const worker = writeInputFromWorker(queue, "x", 10);

  writeFdReadSubscriptionForTesting(view, 0, { userdata: 10n, fd: 0 });
  writeClockSubscriptionForTesting(view, 48, {
    userdata: 11n,
    timeoutNanoseconds: 500_000_000n,
  });

  const scheduler = new WasiPollScheduler({
    memory: () => memory,
    stdin: reader,
    fallbackPoll: () => wasi.ERRNO_INVAL,
  });

  try {
    expect(scheduler.pollOneOff(0, 128, 2, 256)).toBe(wasi.ERRNO_SUCCESS);
    expect(readPollEventsForTesting(view, 128, 1)).toEqual([
      { userdata: 10n, errno: wasi.ERRNO_SUCCESS, eventtype: wasi.EVENTTYPE_FD_READ },
    ]);
    expect(view.getUint32(256, true)).toBe(1);
  } finally {
    await worker.terminate();
  }
});

test("scheduler wakes mixed stdin and clock poll on timeout", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const view = new DataView(memory.buffer);
  const queue = createSharedInputQueue(8);
  const reader = new SharedInputQueueReader(queue);

  writeFdReadSubscriptionForTesting(view, 0, { userdata: 10n, fd: 0 });
  writeClockSubscriptionForTesting(view, 48, {
    userdata: 11n,
    timeoutNanoseconds: 1_000_000n,
  });

  const scheduler = new WasiPollScheduler({
    memory: () => memory,
    stdin: reader,
    fallbackPoll: () => wasi.ERRNO_INVAL,
  });

  expect(scheduler.pollOneOff(0, 128, 2, 256)).toBe(wasi.ERRNO_SUCCESS);
  expect(readPollEventsForTesting(view, 128, 1)).toEqual([
    { userdata: 11n, errno: wasi.ERRNO_SUCCESS, eventtype: wasi.EVENTTYPE_CLOCK },
  ]);
  expect(view.getUint32(256, true)).toBe(1);
});

test("scheduler reports closed stdin as readable hangup", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const view = new DataView(memory.buffer);

  writeFdReadSubscriptionForTesting(view, 0, { userdata: 10n, fd: 0 });

  const scheduler = new WasiPollScheduler({
    memory: () => memory,
    stdin: closedSource(),
    fallbackPoll: () => wasi.ERRNO_INVAL,
  });

  expect(scheduler.pollOneOff(0, 128, 1, 256)).toBe(wasi.ERRNO_SUCCESS);
  expect(readPollEventsForTesting(view, 128, 1)).toEqual([
    { userdata: 10n, errno: wasi.ERRNO_SUCCESS, eventtype: wasi.EVENTTYPE_FD_READ },
  ]);
  expect(view.getBigUint64(128 + 16, true)).toBe(0n);
  expect(view.getUint16(128 + 24, true)).toBe(wasi.EVENTRWFLAGS_FD_READWRITE_HANGUP);
  expect(view.getUint32(256, true)).toBe(1);
});

function closedSource(): WasiPollReadableSource {
  return {
    availableBytes: () => 0,
    isClosed: () => true,
    waitForReadable: () => "closed",
  };
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

test("suspending scheduler completes a relative monotonic clock subscription", async () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const view = new DataView(memory.buffer);
  writeClockSubscriptionForTesting(view, 0, {
    userdata: 21n,
    timeoutNanoseconds: 5_000_000n,
  });

  const scheduler = new SuspendingWasiPollScheduler({
    memory: () => memory,
    stdin: new MainThreadInputQueue(),
    fallbackPoll: () => wasi.ERRNO_INVAL,
  });

  expect(await scheduler.pollOneOff(0, 128, 1, 256)).toBe(wasi.ERRNO_SUCCESS);
  expect(readPollEventsForTesting(view, 128, 1)).toEqual([
    { userdata: 21n, errno: wasi.ERRNO_SUCCESS, eventtype: wasi.EVENTTYPE_CLOCK },
  ]);
  expect(view.getUint32(256, true)).toBe(1);
});

test("suspending scheduler wakes stdin-only poll on queue write", async () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const view = new DataView(memory.buffer);
  writeFdReadSubscriptionForTesting(view, 0, { userdata: 22n, fd: 0 });

  const queue = new MainThreadInputQueue();
  const scheduler = new SuspendingWasiPollScheduler({
    memory: () => memory,
    stdin: queue,
    fallbackPoll: () => wasi.ERRNO_INVAL,
  });

  const poll = scheduler.pollOneOff(0, 128, 1, 256);
  setTimeout(() => queue.write(new Uint8Array([120])), 5);
  expect(await poll).toBe(wasi.ERRNO_SUCCESS);
  expect(readPollEventsForTesting(view, 128, 1)).toEqual([
    { userdata: 22n, errno: wasi.ERRNO_SUCCESS, eventtype: wasi.EVENTTYPE_FD_READ },
  ]);
});

test("suspending scheduler fires the clock leg of a mixed poll without input", async () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const view = new DataView(memory.buffer);
  writeClockSubscriptionForTesting(view, 0, {
    userdata: 23n,
    timeoutNanoseconds: 5_000_000n,
  });
  writeFdReadSubscriptionForTesting(view, 48, { userdata: 24n, fd: 0 });

  const scheduler = new SuspendingWasiPollScheduler({
    memory: () => memory,
    stdin: new MainThreadInputQueue(),
    fallbackPoll: () => wasi.ERRNO_INVAL,
  });

  expect(await scheduler.pollOneOff(0, 128, 2, 256)).toBe(wasi.ERRNO_SUCCESS);
  expect(readPollEventsForTesting(view, 128, 1)).toEqual([
    { userdata: 23n, errno: wasi.ERRNO_SUCCESS, eventtype: wasi.EVENTTYPE_CLOCK },
  ]);
  expect(view.getUint32(256, true)).toBe(1);
});
