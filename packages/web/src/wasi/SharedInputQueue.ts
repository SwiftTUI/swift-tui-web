const controlSlots = 3;
const capacityWaitTimeoutMilliseconds = 50;
const writeDeadlineMilliseconds = 500;

const enum ControlSlot {
  readIndex = 0,
  writeIndex = 1,
  closed = 2,
}

export const sharedInputQueueDefaultCapacity = 64 * 1024;

export interface SharedInputQueueBuffers {
  readonly controlBuffer: SharedArrayBuffer;
  readonly dataBuffer: SharedArrayBuffer;
}

export type SharedInputReadiness = "readable" | "closed" | "timedOut";

/**
 * The outcome of one logical `writeAsync`.
 *
 * `partial` carries how many bytes reached the ring before the deadline. It is
 * distinct from `timedOut`-with-nothing-written because a caller reporting a
 * dropped paste wants to say whether the app saw part of it.
 */
export type SharedInputWriteOutcome =
  | { readonly status: "written" }
  | { readonly status: "closed"; readonly bytesWritten: number }
  | { readonly status: "partial"; readonly bytesWritten: number; readonly bytesRemaining: number };

export interface SharedInputWriteOptions {
  /** Total budget for the whole logical write. Defaults to 500 ms. */
  readonly deadlineMilliseconds?: number;
  /** Injectable clock, so deadline behavior is testable without wall time. */
  readonly now?: () => number;
}

interface SharedInputQueueState {
  readonly control: Int32Array;
  readonly data: Uint8Array;
}

export function createSharedInputQueue(
  capacity: number = sharedInputQueueDefaultCapacity
): SharedInputQueueBuffers {
  if (typeof SharedArrayBuffer === "undefined") {
    throw new Error(
      "SharedArrayBuffer is unavailable. Serve the app with COOP/COEP headers so browser WASI stdin can stay live."
    );
  }

  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new Error(`Shared input queue capacity must be a positive integer, received ${capacity}.`);
  }

  return {
    controlBuffer: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * controlSlots),
    dataBuffer: new SharedArrayBuffer(capacity),
  };
}

export function hydrateSharedInputQueue(
  buffers: SharedInputQueueBuffers
): SharedInputQueueState {
  return {
    control: new Int32Array(buffers.controlBuffer),
    data: new Uint8Array(buffers.dataBuffer),
  };
}

export class SharedInputQueueWriter {
  private readonly queue: SharedInputQueueState;
  /**
   * Serializes `writeAsync` calls. A chunked write suspends while the reader
   * drains, so two concurrent logical writes would otherwise interleave their
   * segments in the ring and corrupt both records.
   */
  private writeChain: Promise<unknown> = Promise.resolve();
  /**
   * How many logical writes are queued or in flight. A write must join the
   * chain whenever one is already pending, or a small later chunk could
   * overtake an earlier chunked one and land out of order.
   */
  private pendingWrites = 0;

  constructor(buffers: SharedInputQueueBuffers) {
    this.queue = hydrateSharedInputQueue(buffers);
  }

  /**
   * Streams one logical write into the ring, in as many segments as the reader's
   * drain rate requires.
   *
   * A single `write` can only ever enqueue what currently fits, so a paste
   * larger than the free space failed outright and the whole clipboard was lost.
   * Here the write takes `min(free, remaining)` bytes at a time and awaits
   * capacity in between, so a paste larger than the ring streams through it
   * while the worker drains. No record shape changes: the bytes arrive in
   * order, so a bracketed paste is still one paste.
   *
   * Never blocks: this runs on the main thread, where `Atomics.wait` is
   * forbidden, so it awaits the reader's notification instead. Each wait is
   * capped at 50 ms (or whatever is left of the deadline) so a missed
   * notification costs one bounded recheck rather than a hang, and the whole
   * write is bounded by a 500 ms deadline.
   */
  writeAsync(
    chunk: Uint8Array | string,
    options: SharedInputWriteOptions = {}
  ): Promise<SharedInputWriteOutcome> {
    const bytes = normalizeChunk(chunk);
    if (bytes.length == 0) {
      return Promise.resolve({ status: "written" });
    }
    if (Atomics.load(this.queue.control, ControlSlot.closed) !== 0) {
      return Promise.resolve({ status: "closed", bytesWritten: 0 });
    }

    // Fast path: with nothing queued ahead of it and room for the whole chunk,
    // the write lands synchronously. That keeps an ordinary keystroke exactly as
    // immediate as it was before chunking existed — only a write that cannot fit
    // pays for suspension.
    if (this.pendingWrites === 0 && bytes.length <= this.availableCapacity()) {
      this.writeSegment(bytes);
      return Promise.resolve({ status: "written" });
    }

    this.pendingWrites += 1;
    const attempt = this.writeChain.then(
      () => this.performChunkedWrite(bytes, options),
      () => this.performChunkedWrite(bytes, options)
    );
    this.writeChain = attempt;
    return attempt.finally(() => {
      this.pendingWrites -= 1;
    });
  }

  private async performChunkedWrite(
    bytes: Uint8Array,
    options: SharedInputWriteOptions
  ): Promise<SharedInputWriteOutcome> {
    const now = options.now ?? (() => Date.now());
    const deadline = now()
      + Math.max(0, options.deadlineMilliseconds ?? writeDeadlineMilliseconds);
    let written = 0;

    while (written < bytes.length) {
      if (Atomics.load(this.queue.control, ControlSlot.closed) !== 0) {
        return { status: "closed", bytesWritten: written };
      }

      const free = this.availableCapacity();
      if (free > 0) {
        const segment = Math.min(free, bytes.length - written);
        this.writeSegment(bytes.subarray(written, written + segment));
        written += segment;
        continue;
      }

      const remainingBudget = deadline - now();
      if (remainingBudget <= 0) {
        return {
          status: "partial",
          bytesWritten: written,
          bytesRemaining: bytes.length - written,
        };
      }
      // `singleWait` keeps the deadline in this loop: without it the helper
      // would spin internally until capacity arrived, ignoring the budget.
      await this.waitForCapacity(1, {
        timeoutMilliseconds: Math.min(capacityWaitTimeoutMilliseconds, remainingBudget),
        singleWait: true,
      });
    }

    return { status: "written" };
  }

  private writeSegment(
    segment: Uint8Array
  ): void {
    const length = this.queue.data.length;
    const writeIndex = Atomics.load(this.queue.control, ControlSlot.writeIndex);
    writeToRingBuffer(this.queue.data, segment, writeIndex);
    Atomics.store(
      this.queue.control,
      ControlSlot.writeIndex,
      ringAdvance(writeIndex, segment.length, length)
    );
    Atomics.notify(this.queue.control, ControlSlot.writeIndex);
  }

  write(chunk: Uint8Array | string): void {
    if (Atomics.load(this.queue.control, ControlSlot.closed) !== 0) {
      return;
    }

    const bytes = normalizeChunk(chunk);
    if (bytes.length == 0) {
      return;
    }

    const length = this.queue.data.length;
    const readIndex = Atomics.load(this.queue.control, ControlSlot.readIndex);
    const writeIndex = Atomics.load(this.queue.control, ControlSlot.writeIndex);
    const usedCapacity = ringUsed(readIndex, writeIndex, length);
    const availableCapacity = length - usedCapacity;

    if (bytes.length > availableCapacity) {
      throw new Error(
        `Shared input queue overflow: cannot enqueue ${bytes.length} byte(s) into ${availableCapacity} byte(s) of free space.`
      );
    }

    writeToRingBuffer(this.queue.data, bytes, writeIndex);
    Atomics.store(
      this.queue.control,
      ControlSlot.writeIndex,
      ringAdvance(writeIndex, bytes.length, length)
    );
    Atomics.notify(this.queue.control, ControlSlot.writeIndex);
  }

  availableCapacity(): number {
    const length = this.queue.data.length;
    const readIndex = Atomics.load(this.queue.control, ControlSlot.readIndex);
    const writeIndex = Atomics.load(this.queue.control, ControlSlot.writeIndex);
    return length - ringUsed(readIndex, writeIndex, length);
  }

  async waitForCapacity(
    minimumBytes: number,
    options: { readonly timeoutMilliseconds?: number; readonly singleWait?: boolean } = {}
  ): Promise<boolean> {
    const required = Math.max(0, Math.ceil(minimumBytes));
    if (required > this.queue.data.length) {
      return false;
    }
    const timeout = options.timeoutMilliseconds ?? capacityWaitTimeoutMilliseconds;

    while (true) {
      const readIndex = Atomics.load(this.queue.control, ControlSlot.readIndex);
      if (Atomics.load(this.queue.control, ControlSlot.closed) !== 0) {
        return false;
      }
      if (this.availableCapacity() >= required) {
        return true;
      }

      if (typeof Atomics.waitAsync === "function") {
        const waiting = Atomics.waitAsync(
          this.queue.control,
          ControlSlot.readIndex,
          readIndex,
          timeout
        );
        if (waiting.async) {
          await waiting.value;
        }
      } else {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 1);
        });
      }

      // One bounded recheck and return, for callers that own the retry loop
      // themselves: a missed notification then costs a single capped wait
      // rather than spinning inside here.
      if (options.singleWait) {
        return this.availableCapacity() >= required;
      }
    }
  }

  close(): void {
    Atomics.store(this.queue.control, ControlSlot.closed, 1);
    Atomics.notify(this.queue.control, ControlSlot.writeIndex);
    Atomics.notify(this.queue.control, ControlSlot.readIndex);
  }
}

export class SharedInputQueueReader {
  private readonly queue: SharedInputQueueState;

  constructor(buffers: SharedInputQueueBuffers) {
    this.queue = hydrateSharedInputQueue(buffers);
  }

  read(maxBytes: number): Uint8Array | undefined {
    while (true) {
      const next = this.readAvailable(maxBytes);
      if (next) {
        return next;
      }

      if (this.isClosed()) {
        return undefined;
      }

      const writeIndex = Atomics.load(this.queue.control, ControlSlot.writeIndex);
      Atomics.wait(this.queue.control, ControlSlot.writeIndex, writeIndex);
    }
  }

  readAvailable(maxBytes: number): Uint8Array | undefined {
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      return new Uint8Array();
    }

    const length = this.queue.data.length;
    const readIndex = Atomics.load(this.queue.control, ControlSlot.readIndex);
    const writeIndex = Atomics.load(this.queue.control, ControlSlot.writeIndex);
    const availableBytes = ringUsed(readIndex, writeIndex, length);

    if (availableBytes <= 0) {
      return undefined;
    }

    const byteCount = Math.min(maxBytes, availableBytes);
    const chunk = readFromRingBuffer(this.queue.data, readIndex, byteCount);
    Atomics.store(
      this.queue.control,
      ControlSlot.readIndex,
      ringAdvance(readIndex, byteCount, length)
    );
    Atomics.notify(this.queue.control, ControlSlot.readIndex);
    return chunk;
  }

  availableBytes(): number {
    const readIndex = Atomics.load(this.queue.control, ControlSlot.readIndex);
    const writeIndex = Atomics.load(this.queue.control, ControlSlot.writeIndex);
    return ringUsed(readIndex, writeIndex, this.queue.data.length);
  }

  waitForReadable(
    timeoutMilliseconds?: number
  ): SharedInputReadiness {
    while (true) {
      if (this.availableBytes() > 0) {
        return "readable";
      }
      if (this.isClosed()) {
        return "closed";
      }

      const writeIndex = Atomics.load(this.queue.control, ControlSlot.writeIndex);
      const result = Atomics.wait(
        this.queue.control,
        ControlSlot.writeIndex,
        writeIndex,
        timeoutMilliseconds
      );
      if (result === "timed-out") {
        return "timedOut";
      }
    }
  }

  isClosed(): boolean {
    return Atomics.load(this.queue.control, ControlSlot.closed) !== 0;
  }
}

function normalizeChunk(
  chunk: Uint8Array | string
): Uint8Array {
  return typeof chunk == "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
}

// The read/write cursors are kept in the half-open range [0, 2 * length) — the
// classic "two indices mod 2N" ring buffer. Bounding both cursors keeps them
// from growing without limit and overflowing Int32 across long sessions, while
// still distinguishing a full queue (used == length) from an empty one
// (used == 0). The data-buffer offset for either cursor is cursor % length.
function ringUsed(
  readIndex: number,
  writeIndex: number,
  length: number
): number {
  const span = 2 * length;
  return ((writeIndex - readIndex) % span + span) % span;
}

function ringAdvance(
  index: number,
  delta: number,
  length: number
): number {
  return (index + delta) % (2 * length);
}

function writeToRingBuffer(
  buffer: Uint8Array,
  chunk: Uint8Array,
  startIndex: number
): void {
  const offset = startIndex % buffer.length;
  const firstSegmentLength = Math.min(chunk.length, buffer.length - offset);
  buffer.set(chunk.subarray(0, firstSegmentLength), offset);
  if (firstSegmentLength < chunk.length) {
    buffer.set(chunk.subarray(firstSegmentLength), 0);
  }
}

function readFromRingBuffer(
  buffer: Uint8Array,
  startIndex: number,
  byteCount: number
): Uint8Array {
  const chunk = new Uint8Array(byteCount);
  const offset = startIndex % buffer.length;
  const firstSegmentLength = Math.min(byteCount, buffer.length - offset);
  chunk.set(buffer.subarray(offset, offset + firstSegmentLength), 0);
  if (firstSegmentLength < byteCount) {
    chunk.set(buffer.subarray(0, byteCount - firstSegmentLength), firstSegmentLength);
  }
  return chunk;
}
