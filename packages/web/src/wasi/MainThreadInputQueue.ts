import type { SharedInputReadiness } from "./SharedInputQueue.ts";
import type { SuspendingWasiPollReadableSource } from "./WasiPollScheduler.ts";

/**
 * Plain single-thread stdin queue for the main-thread (JSPI) execution mode.
 * Fills the role `SharedInputQueue` plays for the worker mode, but readiness
 * is a promise instead of an `Atomics.wait` — no SharedArrayBuffer and
 * therefore no COOP/COEP requirement.
 */
export class MainThreadInputQueue implements SuspendingWasiPollReadableSource {
  private chunks: Uint8Array[] = [];
  private closed = false;
  private waiters: Array<(readiness: SharedInputReadiness) => void> = [];

  write(chunk: Uint8Array): void {
    if (this.closed || chunk.byteLength === 0) {
      return;
    }
    this.chunks.push(chunk);
    this.resolveWaiters("readable");
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.resolveWaiters("closed");
  }

  isClosed(): boolean {
    return this.closed && this.chunks.length === 0;
  }

  availableBytes(): number {
    return this.chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  }

  readAvailable(size: number): Uint8Array | undefined {
    const first = this.chunks[0];
    if (!first) {
      return undefined;
    }
    if (first.byteLength <= size) {
      this.chunks = this.chunks.slice(1);
      return first;
    }
    this.chunks = [first.subarray(size), ...this.chunks.slice(1)];
    return first.subarray(0, size);
  }

  waitForReadableAsync(
    timeoutMilliseconds?: number
  ): Promise<SharedInputReadiness> {
    if (this.chunks.length > 0) {
      return Promise.resolve("readable");
    }
    if (this.closed) {
      return Promise.resolve("closed");
    }
    return new Promise((resolve) => {
      const waiter = (readiness: SharedInputReadiness): void => resolve(readiness);
      this.waiters = [...this.waiters, waiter];
      if (timeoutMilliseconds !== undefined && Number.isFinite(timeoutMilliseconds)) {
        setTimeout(() => {
          if (this.waiters.includes(waiter)) {
            this.waiters = this.waiters.filter((pending) => pending !== waiter);
            resolve("timedOut");
          }
        }, Math.max(0, timeoutMilliseconds));
      }
    });
  }

  private resolveWaiters(readiness: SharedInputReadiness): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const waiter of waiters) {
      waiter(readiness);
    }
  }
}
