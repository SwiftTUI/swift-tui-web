import { expect, test } from "bun:test";
import { Worker } from "node:worker_threads";
import { wasi } from "@bjorn3/browser_wasi_shim";

import {
  MainThreadWasmPauseGate,
  PausableMonotonicClock,
  WorkerWasmPauseGate,
  createWasmPauseCell,
  installPausableClockTimeGet,
  isWasmPauseCellPaused,
  setWasmPauseCellPaused,
} from "./WasmRuntimePause.ts";

test("pausable clock excludes accumulated pause time", () => {
  let raw = 100;
  const clock = new PausableMonotonicClock(() => raw);

  expect(clock.nowMilliseconds()).toBe(100);

  clock.addPausedMilliseconds(30);
  raw = 150;
  expect(clock.nowMilliseconds()).toBe(120);
  expect(clock.pausedMilliseconds).toBe(30);

  clock.addPausedMilliseconds(-5);
  expect(clock.pausedMilliseconds).toBe(30);

  expect(clock.nowNanoseconds()).toBe(120_000_000n);
});

test("pause cell round-trips the paused flag", () => {
  const cell = createWasmPauseCell();
  expect(isWasmPauseCellPaused(cell)).toBe(false);

  setWasmPauseCellPaused(cell, true);
  expect(isWasmPauseCellPaused(cell)).toBe(true);

  setWasmPauseCellPaused(cell, false);
  expect(isWasmPauseCellPaused(cell)).toBe(false);
});

test("worker pause gate passes through immediately while running", () => {
  const cell = createWasmPauseCell();
  const clock = new PausableMonotonicClock(() => 0);
  const gate = new WorkerWasmPauseGate(cell, clock);

  gate.blockWhilePaused();
  expect(clock.pausedMilliseconds).toBe(0);
});

test("worker pause gate parks until resumed and credits the clock", async () => {
  const cell = createWasmPauseCell();
  const clock = new PausableMonotonicClock();
  const gate = new WorkerWasmPauseGate(cell, clock);

  setWasmPauseCellPaused(cell, true);
  const worker = resumePauseCellFromWorker(cell, 20);
  try {
    gate.blockWhilePaused();
    expect(isWasmPauseCellPaused(cell)).toBe(false);
    expect(clock.pausedMilliseconds).toBeGreaterThan(0);
  } finally {
    await worker.terminate();
  }
});

test("main-thread pause gate suspends waiters until resumed", async () => {
  let raw = 0;
  const clock = new PausableMonotonicClock(() => raw);
  const gate = new MainThreadWasmPauseGate(clock, () => raw);

  gate.setPaused(true);
  expect(gate.isPaused).toBe(true);

  let released = false;
  const wait = gate.waitWhilePaused().then(() => {
    released = true;
  });

  await Promise.resolve();
  expect(released).toBe(false);

  raw = 40;
  gate.setPaused(false);
  await wait;
  expect(released).toBe(true);
  expect(clock.pausedMilliseconds).toBe(40);

  // Running gate is a pass-through.
  await gate.waitWhilePaused();
  expect(clock.pausedMilliseconds).toBe(40);
});

test("pausable clock_time_get rewrites monotonic reads and passes realtime through", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  let raw = 500;
  const clock = new PausableMonotonicClock(() => raw);
  clock.addPausedMilliseconds(200);

  let realtimeCalls = 0;
  const wasiImport: Record<string, unknown> = {
    clock_time_get: (_clockid: number, _precision: bigint, timePtr: number): number => {
      realtimeCalls += 1;
      new DataView(memory.buffer).setBigUint64(timePtr, 42n, true);
      return wasi.ERRNO_SUCCESS;
    },
  };

  installPausableClockTimeGet(wasiImport, () => memory, clock);
  const clockTimeGet = wasiImport.clock_time_get as (
    clockid: number,
    precision: bigint,
    timePtr: number
  ) => number;

  expect(clockTimeGet(wasi.CLOCKID_MONOTONIC, 0n, 8)).toBe(wasi.ERRNO_SUCCESS);
  expect(new DataView(memory.buffer).getBigUint64(8, true)).toBe(300_000_000n);
  expect(realtimeCalls).toBe(0);

  expect(clockTimeGet(wasi.CLOCKID_REALTIME, 0n, 16)).toBe(wasi.ERRNO_SUCCESS);
  expect(new DataView(memory.buffer).getBigUint64(16, true)).toBe(42n);
  expect(realtimeCalls).toBe(1);
});

function resumePauseCellFromWorker(
  cell: SharedArrayBuffer,
  delayMilliseconds: number
): Worker {
  return new Worker(`
    const { workerData } = require("node:worker_threads");
    const flags = new Int32Array(workerData.cell);
    setTimeout(() => {
      Atomics.store(flags, 0, 0);
      Atomics.notify(flags, 0);
    }, workerData.delayMilliseconds);
  `, {
    eval: true,
    workerData: {
      cell,
      delayMilliseconds,
    },
  });
}
