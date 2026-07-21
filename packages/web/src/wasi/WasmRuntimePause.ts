import { wasi } from "@bjorn3/browser_wasi_shim";

const pausedFlagValue = 1;

/**
 * A monotonic clock that excludes time spent paused. `nowMilliseconds()`
 * mirrors `performance.now()` minus every accumulated pause, so WASI clock
 * reads (`clock_time_get`) and `poll_oneoff` deadline math both observe a
 * frozen clock across a pause: pending timeouts keep their remaining time,
 * no expired-deadline catch-up burst fires on resume, and app-side animation
 * clocks do not jump.
 */
export class PausableMonotonicClock {
  private readonly rawNowMilliseconds: () => number;
  private accumulatedPauseMilliseconds = 0;

  constructor(rawNowMilliseconds: () => number = () => performance.now()) {
    this.rawNowMilliseconds = rawNowMilliseconds;
  }

  nowMilliseconds(): number {
    return this.rawNowMilliseconds() - this.accumulatedPauseMilliseconds;
  }

  nowNanoseconds(): bigint {
    return BigInt(Math.round(this.nowMilliseconds() * 1e6));
  }

  addPausedMilliseconds(
    milliseconds: number
  ): void {
    if (milliseconds > 0) {
      this.accumulatedPauseMilliseconds += milliseconds;
    }
  }

  get pausedMilliseconds(): number {
    return this.accumulatedPauseMilliseconds;
  }
}

/**
 * Creates the shared pause cell the main thread uses to suspend a wasm scene
 * worker. One Int32 slot: 0 = running, 1 = paused. The worker parks on the
 * cell between `poll_oneoff` waits, so a paused scene costs zero CPU.
 */
export function createWasmPauseCell(): SharedArrayBuffer {
  if (typeof SharedArrayBuffer === "undefined") {
    throw new Error(
      "SharedArrayBuffer is unavailable. Serve the app with COOP/COEP headers so worker-mode pause can work."
    );
  }
  return new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
}

export function setWasmPauseCellPaused(
  cell: SharedArrayBuffer,
  paused: boolean
): void {
  const flags = new Int32Array(cell);
  Atomics.store(flags, 0, paused ? pausedFlagValue : 0);
  if (!paused) {
    Atomics.notify(flags, 0);
  }
}

export function isWasmPauseCellPaused(
  cell: SharedArrayBuffer
): boolean {
  return Atomics.load(new Int32Array(cell), 0) === pausedFlagValue;
}

/**
 * Worker-side pause gate: blocks the calling (worker) thread while the shared
 * pause cell is set, then credits the parked wall time to the pausable clock.
 * Must never run on a browser main thread — `Atomics.wait` is worker-only.
 */
export class WorkerWasmPauseGate {
  private readonly flags: Int32Array;
  private readonly clock: PausableMonotonicClock;
  private readonly rawNowMilliseconds: () => number;

  constructor(
    cell: SharedArrayBuffer,
    clock: PausableMonotonicClock,
    rawNowMilliseconds: () => number = () => performance.now()
  ) {
    this.flags = new Int32Array(cell);
    this.clock = clock;
    this.rawNowMilliseconds = rawNowMilliseconds;
  }

  blockWhilePaused(): void {
    let pausedMilliseconds = 0;
    while (Atomics.load(this.flags, 0) === pausedFlagValue) {
      const parkStart = this.rawNowMilliseconds();
      Atomics.wait(this.flags, 0, pausedFlagValue);
      pausedMilliseconds += this.rawNowMilliseconds() - parkStart;
    }
    this.clock.addPausedMilliseconds(pausedMilliseconds);
  }
}

/**
 * Main-thread (JSPI) pause gate: the awaited counterpart of
 * `WorkerWasmPauseGate`. While paused, `waitWhilePaused` suspends on a promise
 * that `setPaused(false)` resolves, then credits the parked time to the clock.
 */
export class MainThreadWasmPauseGate {
  private readonly clock: PausableMonotonicClock;
  private readonly rawNowMilliseconds: () => number;
  private paused = false;
  private resumeWaiters: Array<() => void> = [];

  constructor(
    clock: PausableMonotonicClock,
    rawNowMilliseconds: () => number = () => performance.now()
  ) {
    this.clock = clock;
    this.rawNowMilliseconds = rawNowMilliseconds;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  setPaused(
    paused: boolean
  ): void {
    if (this.paused === paused) {
      return;
    }
    this.paused = paused;
    if (!paused) {
      const waiters = this.resumeWaiters;
      this.resumeWaiters = [];
      for (const resume of waiters) {
        resume();
      }
    }
  }

  async waitWhilePaused(): Promise<void> {
    let pausedMilliseconds = 0;
    while (this.paused) {
      const parkStart = this.rawNowMilliseconds();
      await new Promise<void>((resolve) => {
        this.resumeWaiters.push(resolve);
      });
      pausedMilliseconds += this.rawNowMilliseconds() - parkStart;
    }
    this.clock.addPausedMilliseconds(pausedMilliseconds);
  }
}

type ClockTimeGet = (clockid: number, precision: bigint, timePtr: number) => number;

/**
 * Redirects the WASI `clock_time_get` import's MONOTONIC reads through the
 * pausable clock so app-side time agrees with the pause-aware `poll_oneoff`
 * deadline math. Non-monotonic clocks (REALTIME) keep the shim's behavior —
 * wall-clock time genuinely advances across a pause.
 */
export function installPausableClockTimeGet(
  wasiImport: Record<string, unknown>,
  memory: () => WebAssembly.Memory | undefined,
  clock: PausableMonotonicClock
): void {
  const original = wasiImport.clock_time_get as ClockTimeGet | undefined;
  if (typeof original !== "function") {
    return;
  }
  wasiImport.clock_time_get = (
    clockid: number,
    precision: bigint,
    timePtr: number
  ): number => {
    if (clockid !== wasi.CLOCKID_MONOTONIC) {
      return original(clockid, precision, timePtr);
    }
    const currentMemory = memory();
    if (!currentMemory) {
      return original(clockid, precision, timePtr);
    }
    new DataView(currentMemory.buffer).setBigUint64(timePtr, clock.nowNanoseconds(), true);
    return wasi.ERRNO_SUCCESS;
  };
}
