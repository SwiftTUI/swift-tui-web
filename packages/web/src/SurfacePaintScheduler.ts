import type {
  WebHostAccessibilityAnnouncement,
  WebHostSurfaceDamage,
  WebHostSurfaceDamageRange,
  WebHostSurfaceDamageTextRow,
  WebHostSurfaceFrame,
  WebHostSurfaceImage,
} from "./WebHostSurfaceTransport.ts";

/**
 * The animation-frame pair the scene runtime paints through. The runtime
 * resolves the global `requestAnimationFrame`/`cancelAnimationFrame` by
 * default; tests inject a manually ticked pair, and a host without animation
 * frames (a non-browser test runner, server-side rendering) paints
 * synchronously on every presented frame instead.
 */
export interface WebHostAnimationFrameScheduler {
  requestAnimationFrame(callback: (time: number) => void): number;
  cancelAnimationFrame(handle: number): void;
}

/**
 * How the runtime schedules visual paints: an animation-frame pair, or
 * `"synchronous"` to paint every presented frame immediately (the behavior
 * before paint batching, kept for hosts that must observe each frame).
 */
export type WebHostPaintScheduling =
  | WebHostAnimationFrameScheduler
  | "synchronous";

/**
 * The global animation-frame pair, or `undefined` where the host has none.
 * Bound explicitly because both functions throw when detached from their
 * `window` receiver.
 */
export function defaultAnimationFrameScheduler():
  | WebHostAnimationFrameScheduler
  | undefined {
  const request = globalThis.requestAnimationFrame;
  const cancel = globalThis.cancelAnimationFrame;
  if (typeof request !== "function" || typeof cancel !== "function") {
    return undefined;
  }
  return {
    requestAnimationFrame: (callback) => request.call(globalThis, callback),
    cancelAnimationFrame: (handle) => cancel.call(globalThis, handle),
  };
}

/** One visual paint standing in for every frame presented since the last one. */
export interface SurfacePaintRequest {
  /**
   * The newest presented frame, with image payloads that only coalesced
   * (never painted) frames carried spliced into images that repeat the id
   * without bytes. `undefined` before the first frame clears the surface.
   */
  frame: WebHostSurfaceFrame | undefined;
  /** Damage relative to the last painted frame; `undefined` repaints fully. */
  damage: WebHostSurfaceDamage | undefined;
  /** Payload ids answering an outstanding recovery request in any coalesced frame. */
  recoveredImagePayloadIds: readonly string[];
  /** Imperative announcements from every coalesced frame, in transport order. */
  accessibilityAnnouncements: readonly WebHostAccessibilityAnnouncement[];
  /** Presented frames this paint replaces beyond the newest one. */
  coalescedFrameCount: number;
}

/** Paint-scheduler counters, for journeys and diagnostics. */
export interface WebHostPaintStatistics {
  /** Frames handed to `present`. */
  presentedFrames: number;
  /** Paints delivered to the painter, including repaint-only paints. */
  paints: number;
  /** Presented frames that never reached the painter individually. */
  coalescedFrames: number;
  /** Whether a paint is scheduled but not yet delivered. */
  pending: boolean;
}

interface PendingPaint {
  frame: WebHostSurfaceFrame | undefined;
  damage: WebHostSurfaceDamage | undefined;
  /** `dataBase64` by image id from frames this paint superseded. */
  carriedImagePayloads: Map<string, string>;
  recoveredImagePayloadIds: Set<string>;
  accessibilityAnnouncements: WebHostAccessibilityAnnouncement[];
  coalescedFrameCount: number;
}

/**
 * Coalesces presented surface frames into at most one visual paint per
 * animation frame while keeping every non-visual consequence of the skipped
 * frames.
 *
 * Records are still decoded and applied in transport order by the bridges;
 * only the paint is deferred. Between paints the scheduler keeps the newest
 * frame and folds the frames it supersedes into it:
 *
 * - **Damage** is unioned, because each frame's damage is relative to the
 *   frame before it on the wire, not to the frame last painted. A change of
 *   grid size or epoch, or a frame without damage, promotes to a full repaint.
 * - **Image payloads** carried only by a superseded frame are spliced into the
 *   painted frame's matching image, so a content-addressed image that arrived
 *   with bytes once is never reported missing merely because its record was
 *   coalesced. Recovered payload ids are unioned for the same reason.
 * - **Accessibility announcements** are concatenated in order, so none is
 *   lost; the tree itself is presented once, from the newest frame.
 *
 * Without an animation-frame scheduler every `present` paints synchronously,
 * which is the pre-batching behavior.
 */
export class SurfacePaintScheduler {
  private pending?: PendingPaint;
  private lastPaintedFrame?: WebHostSurfaceFrame;
  private handle?: number;
  private disposed = false;
  private held = false;
  private presentedFrames = 0;
  private paints = 0;
  private coalescedFrames = 0;

  constructor(
    private readonly animationFrames:
      | WebHostAnimationFrameScheduler
      | undefined,
    private readonly paint: (request: SurfacePaintRequest) => void,
  ) {}

  get statistics(): WebHostPaintStatistics {
    return {
      presentedFrames: this.presentedFrames,
      paints: this.paints,
      coalescedFrames: this.coalescedFrames,
      pending: this.pending !== undefined,
    };
  }

  /** Whether the scheduler defers paints to animation frames at all. */
  get batchesPaints(): boolean {
    return this.animationFrames !== undefined;
  }

  /** Queues a decoded frame for the next paint, superseding any frame still pending. */
  present(
    frame: WebHostSurfaceFrame,
    recoveredImagePayloadIds: readonly string[] = [],
  ): void {
    if (this.disposed) {
      return;
    }
    this.presentedFrames += 1;
    const pending = this.pending;
    const previous = pending ? pending.frame : this.lastPaintedFrame;
    const damage = promotesToFullRepaint(previous, frame)
      ? undefined
      : pending
        ? unionSurfaceDamage(pending.damage, frame.damage)
        : frame.damage;

    const next: PendingPaint = pending ?? {
      frame: undefined,
      damage: undefined,
      carriedImagePayloads: new Map(),
      recoveredImagePayloadIds: new Set(),
      accessibilityAnnouncements: [],
      coalescedFrameCount: 0,
    };
    if (pending?.frame && pending.frame !== this.lastPaintedFrame) {
      // The superseded frame never reaches the painter: keep what only it
      // carried. Its announcements were already appended when it arrived.
      for (const image of pending.frame.images ?? []) {
        if (image.dataBase64 !== undefined) {
          next.carriedImagePayloads.set(image.id, image.dataBase64);
        }
      }
      next.coalescedFrameCount += 1;
      this.coalescedFrames += 1;
    }
    next.frame = frame;
    next.damage = damage;
    for (const id of recoveredImagePayloadIds) {
      next.recoveredImagePayloadIds.add(id);
    }
    next.accessibilityAnnouncements.push(
      ...(frame.accessibilityAnnouncements ?? []),
    );
    this.pending = next;
    this.schedule();
  }

  /**
   * Asks for a full repaint of the newest frame on the next animation frame —
   * after an image decode completes, for instance. Folds into a pending paint
   * rather than adding one.
   */
  requestRepaint(): void {
    if (this.disposed) {
      return;
    }
    this.promoteToFullRepaint();
    this.schedule();
  }

  /**
   * Paints the newest frame fully, now. For the moments a deferred paint
   * would leave the surface visibly wrong: a canvas whose backing store was
   * just resized (and therefore cleared), a restyle, or a document that has
   * just become visible after animation frames were paused.
   */
  repaintNow(): void {
    if (this.disposed) {
      return;
    }
    this.promoteToFullRepaint();
    this.flush();
  }

  /** Delivers the pending paint immediately, if there is one. */
  flush(): void {
    if (this.disposed || this.held) {
      return;
    }
    this.cancelScheduled();
    const pending = this.pending;
    if (!pending) {
      return;
    }
    this.pending = undefined;
    const frame = pending.frame
      ? spliceCarriedImagePayloads(pending.frame, pending.carriedImagePayloads)
      : undefined;
    this.lastPaintedFrame = frame;
    this.paints += 1;
    this.paint({
      frame,
      damage: pending.damage,
      recoveredImagePayloadIds: [...pending.recoveredImagePayloadIds].sort(),
      accessibilityAnnouncements: pending.accessibilityAnnouncements,
      coalescedFrameCount: pending.coalescedFrameCount,
    });
  }

  /** Cancels any scheduled paint and ignores everything afterwards. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.cancelScheduled();
    this.pending = undefined;
    this.lastPaintedFrame = undefined;
    this.disposed = true;
  }

  /** Makes the pending paint full, creating one for the painted frame if needed. */
  private promoteToFullRepaint(): void {
    if (this.pending) {
      this.pending.damage = undefined;
      return;
    }
    this.pending = {
      frame: this.lastPaintedFrame,
      damage: undefined,
      carriedImagePayloads: new Map(),
      recoveredImagePayloadIds: new Set(),
      accessibilityAnnouncements: [],
      coalescedFrameCount: 0,
    };
  }

  private schedule(): void {
    if (this.held) return;
    if (!this.animationFrames) {
      this.flush();
      return;
    }
    if (this.handle !== undefined) {
      return;
    }
    this.handle = this.animationFrames.requestAnimationFrame(() => {
      this.handle = undefined;
      this.flush();
    });
  }

  private cancelScheduled(): void {
    if (this.handle === undefined) {
      return;
    }
    this.animationFrames?.cancelAnimationFrame(this.handle);
    this.handle = undefined;
  }

  /** Retains the latest frame, payloads and announcements until presentation is measurable. */
  setHeld(held: boolean): void {
    if (this.disposed || held === this.held) return;
    this.held = held;
    if (held) this.cancelScheduled();
    else if (this.pending) this.schedule();
  }
}

/**
 * Whether `frame`'s damage cannot be applied on top of `previous`: there is
 * no previous frame, the grid changed size, the epoch moved (a re-anchored
 * stream's first frame is not a delta of the old one), or the frame carries
 * no damage at all.
 */
function promotesToFullRepaint(
  previous: WebHostSurfaceFrame | undefined,
  frame: WebHostSurfaceFrame,
): boolean {
  return (
    previous === undefined ||
    previous.width !== frame.width ||
    previous.height !== frame.height ||
    previous.epoch !== frame.epoch ||
    frame.damage === undefined
  );
}

/**
 * The newest frame with `dataBase64` restored on images that repeat an id
 * whose bytes only a coalesced frame carried. Returns `frame` itself when
 * nothing needs splicing, so repaints of an unchanged frame keep its identity.
 */
function spliceCarriedImagePayloads(
  frame: WebHostSurfaceFrame,
  carried: Map<string, string>,
): WebHostSurfaceFrame {
  if (carried.size === 0 || !frame.images?.length) {
    return frame;
  }
  let spliced = false;
  const images: WebHostSurfaceImage[] = frame.images.map((image) => {
    if (image.dataBase64 !== undefined) {
      return image;
    }
    const payload = carried.get(image.id);
    if (payload === undefined) {
      return image;
    }
    spliced = true;
    return { ...image, dataBase64: payload };
  });
  return spliced ? { ...frame, images } : frame;
}

/**
 * The damage covering both `a` and `b` applied in sequence. `undefined` on
 * either side already means "everything", so it absorbs. Per row, an empty
 * range list means the whole row and absorbs likewise; otherwise the ranges
 * are merged where they touch or overlap.
 */
export function unionSurfaceDamage(
  a: WebHostSurfaceDamage | undefined,
  b: WebHostSurfaceDamage | undefined,
): WebHostSurfaceDamage | undefined {
  if (!a || !b) {
    return undefined;
  }
  const rows = new Map<number, WebHostSurfaceDamageRange[] | "full">();
  for (const [row, ranges] of [...a.textRows, ...b.textRows]) {
    const existing = rows.get(row);
    if (existing === "full") {
      continue;
    }
    if (ranges.length === 0) {
      rows.set(row, "full");
      continue;
    }
    rows.set(row, existing ? [...existing, ...ranges] : [...ranges]);
  }
  const textRows: WebHostSurfaceDamageTextRow[] = [...rows.entries()]
    .sort(([left], [right]) => left - right)
    .map(([row, ranges]) => [
      row,
      ranges === "full" ? [] : mergeDamageRanges(ranges),
    ]);
  return {
    textRows,
    requiresFullTextRepaint:
      a.requiresFullTextRepaint || b.requiresFullTextRepaint,
    requiresFullGraphicsReplay:
      a.requiresFullGraphicsReplay || b.requiresFullGraphicsReplay,
  };
}

/** Sorted, non-overlapping `[start, end)` ranges; touching ranges join. */
function mergeDamageRanges(
  ranges: readonly WebHostSurfaceDamageRange[],
): WebHostSurfaceDamageRange[] {
  const sorted = [...ranges].sort(([left], [right]) => left - right);
  const merged: WebHostSurfaceDamageRange[] = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) {
      merged[merged.length - 1] = [last[0], Math.max(last[1], end)];
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}
