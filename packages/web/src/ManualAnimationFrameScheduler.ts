import type { WebHostAnimationFrameScheduler } from "./SurfacePaintScheduler.ts";

/**
 * An animation-frame pair advanced by hand, for deterministic paint tests.
 * Pass it as `paintScheduling` to a `WebHostSceneRuntime`; frames presented
 * to the runtime then stay pending until {@link tick} runs the callbacks
 * requested so far, exactly as a browser would at its next animation frame.
 */
export class ManualAnimationFrameScheduler
  implements WebHostAnimationFrameScheduler
{
  private nextHandle = 1;
  private readonly callbacks = new Map<number, (time: number) => void>();
  private time = 0;
  /** Callbacks requested since construction. */
  requests = 0;
  /** Requested callbacks cancelled before they ran. */
  cancels = 0;

  requestAnimationFrame(callback: (time: number) => void): number {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.callbacks.set(handle, callback);
    this.requests += 1;
    return handle;
  }

  cancelAnimationFrame(handle: number): void {
    if (this.callbacks.delete(handle)) {
      this.cancels += 1;
    }
  }

  /** Callbacks requested and neither run nor cancelled. */
  get scheduled(): number {
    return this.callbacks.size;
  }

  /**
   * Runs every callback requested so far, once, in request order. Callbacks
   * requested while ticking wait for the next tick, as in a browser.
   */
  tick(elapsedMilliseconds = 16): void {
    this.time += elapsedMilliseconds;
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) {
      callback(this.time);
    }
  }
}
