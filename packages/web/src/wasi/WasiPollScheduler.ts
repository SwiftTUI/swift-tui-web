import { wasi } from "@bjorn3/browser_wasi_shim";

import type { SharedInputReadiness } from "./SharedInputQueue.ts";

const subscriptionByteLength = 48;
const eventByteLength = 32;
const maximumAtomicsWaitMilliseconds = 2_147_483_647;

interface ClockSubscription {
  readonly type: "clock";
  readonly userdata: bigint;
  readonly clockid: number;
  readonly deadlineMilliseconds: number;
}

interface FdReadSubscription {
  readonly type: "fdRead";
  readonly userdata: bigint;
  readonly fd: number;
}

type SupportedSubscription = ClockSubscription | FdReadSubscription;

export interface WasiPollReadableSource {
  availableBytes(): number;
  isClosed(): boolean;
  waitForReadable(timeoutMilliseconds?: number): SharedInputReadiness;
}

export interface WasiPollSchedulerOptions {
  memory(): WebAssembly.Memory | undefined;
  stdin: WasiPollReadableSource;
  fallbackPoll(
    inPtr: number,
    outPtr: number,
    nsubscriptions: number,
    neventsPtr?: number
  ): number;
  nowMilliseconds?(): number;
}

export class WasiPollScheduler {
  private readonly memory: WasiPollSchedulerOptions["memory"];
  private readonly stdin: WasiPollReadableSource;
  private readonly fallbackPoll: WasiPollSchedulerOptions["fallbackPoll"];
  private readonly nowMilliseconds: () => number;
  private readonly waitBuffer = new Int32Array(
    new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)
  );

  constructor(options: WasiPollSchedulerOptions) {
    this.memory = options.memory;
    this.stdin = options.stdin;
    this.fallbackPoll = options.fallbackPoll;
    this.nowMilliseconds = options.nowMilliseconds ?? (() => performance.now());
  }

  pollOneOff(
    inPtr: number,
    outPtr: number,
    nsubscriptions: number,
    neventsPtr?: number
  ): number {
    const memory = this.memory();
    if (!memory || nsubscriptions <= 0) {
      return this.fallbackPoll(inPtr, outPtr, nsubscriptions, neventsPtr);
    }

    const view = new DataView(memory.buffer);
    const subscriptions = readSubscriptions(
      view,
      inPtr,
      nsubscriptions,
      this.nowMilliseconds()
    );
    if (subscriptions === undefined) {
      return this.fallbackPoll(inPtr, outPtr, nsubscriptions, neventsPtr);
    }

    while (true) {
      const ready = readySubscriptions(subscriptions, this.stdin, this.nowMilliseconds());
      if (ready.length > 0) {
        writeEvents(view, outPtr, ready, this.stdin);
        if (neventsPtr !== undefined) {
          view.setUint32(neventsPtr, ready.length, true);
        }
        return wasi.ERRNO_SUCCESS;
      }

      const timeoutMilliseconds = shortestClockTimeoutMilliseconds(
        subscriptions,
        this.nowMilliseconds()
      );
      if (hasFdReadSubscription(subscriptions)) {
        this.stdin.waitForReadable(timeoutMilliseconds);
      } else if (timeoutMilliseconds !== undefined) {
        Atomics.wait(
          this.waitBuffer,
          0,
          0,
          Math.min(timeoutMilliseconds, maximumAtomicsWaitMilliseconds)
        );
      } else {
        return this.fallbackPoll(inPtr, outPtr, nsubscriptions, neventsPtr);
      }
    }
  }
}

function readSubscriptions(
  view: DataView,
  inPtr: number,
  nsubscriptions: number,
  nowMilliseconds: number
): SupportedSubscription[] | undefined {
  const subscriptions: SupportedSubscription[] = [];
  for (let index = 0; index < nsubscriptions; index += 1) {
    const subscription = wasi.Subscription.read_bytes(
      view,
      inPtr + index * subscriptionByteLength
    );
    switch (subscription.eventtype) {
    case wasi.EVENTTYPE_CLOCK:
      if (!isSupportedClockId(subscription.clockid)) {
        return undefined;
      }
      subscriptions.push({
        type: "clock",
        userdata: subscription.userdata,
        clockid: subscription.clockid,
        deadlineMilliseconds: clockDeadlineMilliseconds(subscription, nowMilliseconds),
      });
      break;
    case wasi.EVENTTYPE_FD_READ:
      if (subscription.clockid !== wasi.FD_STDIN) {
        return undefined;
      }
      subscriptions.push({
        type: "fdRead",
        userdata: subscription.userdata,
        fd: subscription.clockid,
      });
      break;
    default:
      return undefined;
    }
  }
  return subscriptions;
}

function isSupportedClockId(
  clockid: number
): boolean {
  return clockid === wasi.CLOCKID_MONOTONIC || clockid === wasi.CLOCKID_REALTIME;
}

function shortestClockTimeoutMilliseconds(
  subscriptions: readonly SupportedSubscription[],
  nowMilliseconds: number
): number | undefined {
  let timeoutMilliseconds: number | undefined;
  for (const subscription of subscriptions) {
    if (subscription.type !== "clock") {
      continue;
    }
    const remaining = clockRemainingMilliseconds(subscription, nowMilliseconds);
    timeoutMilliseconds = timeoutMilliseconds === undefined
      ? remaining
      : Math.min(timeoutMilliseconds, remaining);
  }
  return timeoutMilliseconds;
}

function readySubscriptions(
  subscriptions: readonly SupportedSubscription[],
  stdin: WasiPollReadableSource,
  nowMilliseconds: number
): SupportedSubscription[] {
  return subscriptions.filter((subscription) => {
    switch (subscription.type) {
    case "clock":
      return clockRemainingMilliseconds(subscription, nowMilliseconds) <= 0;
    case "fdRead":
      return stdin.availableBytes() > 0 || stdin.isClosed();
    }
  });
}

function hasFdReadSubscription(
  subscriptions: readonly SupportedSubscription[]
): boolean {
  return subscriptions.some((subscription) => subscription.type === "fdRead");
}

function clockRemainingMilliseconds(
  subscription: ClockSubscription,
  nowMilliseconds: number
): number {
  return Math.max(0, subscription.deadlineMilliseconds - nowMillisecondsForClock(
    subscription.clockid,
    nowMilliseconds
  ));
}

function clockDeadlineMilliseconds(
  subscription: wasi.Subscription,
  nowMilliseconds: number
): number {
  if ((subscription.flags & wasi.SUBCLOCKFLAGS_SUBSCRIPTION_CLOCK_ABSTIME) !== 0) {
    return Number(subscription.timeout) / 1_000_000;
  }
  return nowMillisecondsForClock(subscription.clockid, nowMilliseconds)
    + Number(subscription.timeout) / 1_000_000;
}

function nowMillisecondsForClock(
  clockid: number,
  nowMilliseconds: number
): number {
  if (clockid === wasi.CLOCKID_REALTIME) {
    return Date.now();
  }
  return nowMilliseconds;
}

function writeEvents(
  view: DataView,
  outPtr: number,
  subscriptions: readonly SupportedSubscription[],
  stdin: WasiPollReadableSource
): void {
  subscriptions.forEach((subscription, index) => {
    const eventtype = subscription.type === "clock"
      ? wasi.EVENTTYPE_CLOCK
      : wasi.EVENTTYPE_FD_READ;
    const offset = outPtr + index * eventByteLength;
    new wasi.Event(
      subscription.userdata,
      wasi.ERRNO_SUCCESS,
      eventtype
    ).write_bytes(view, offset);
    if (subscription.type === "fdRead") {
      const availableBytes = Math.max(0, stdin.availableBytes());
      view.setBigUint64(offset + 16, BigInt(availableBytes), true);
      if (availableBytes === 0 && stdin.isClosed()) {
        view.setUint16(offset + 24, wasi.EVENTRWFLAGS_FD_READWRITE_HANGUP, true);
      }
    }
  });
}

export function writeClockSubscriptionForTesting(
  view: DataView,
  offset: number,
  subscription: {
    userdata: bigint;
    timeoutNanoseconds: bigint;
    clockid?: number;
    flags?: number;
  }
): void {
  clearRecord(view, offset, subscriptionByteLength);
  view.setBigUint64(offset, subscription.userdata, true);
  view.setUint8(offset + 8, wasi.EVENTTYPE_CLOCK);
  view.setUint32(offset + 16, subscription.clockid ?? wasi.CLOCKID_MONOTONIC, true);
  view.setBigUint64(offset + 24, subscription.timeoutNanoseconds, true);
  view.setUint16(offset + 36, subscription.flags ?? 0, true);
}

export function writeFdReadSubscriptionForTesting(
  view: DataView,
  offset: number,
  subscription: {
    userdata: bigint;
    fd: number;
  }
): void {
  clearRecord(view, offset, subscriptionByteLength);
  view.setBigUint64(offset, subscription.userdata, true);
  view.setUint8(offset + 8, wasi.EVENTTYPE_FD_READ);
  view.setUint32(offset + 16, subscription.fd, true);
}

export function readPollEventsForTesting(
  view: DataView,
  offset: number,
  count: number
): Array<{ userdata: bigint; errno: number; eventtype: number }> {
  return Array.from({ length: count }, (_, index) => {
    const eventOffset = offset + index * eventByteLength;
    return {
      userdata: view.getBigUint64(eventOffset, true),
      errno: view.getUint16(eventOffset + 8, true),
      eventtype: view.getUint8(eventOffset + 10),
    };
  });
}

function clearRecord(
  view: DataView,
  offset: number,
  byteLength: number
): void {
  new Uint8Array(view.buffer, offset, byteLength).fill(0);
}
