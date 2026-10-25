import type { StdIOPipe } from "./StdIOPipe.ts";

// Package-internal: no public entrypoint re-exports this module. It reports a
// stdin write's delivery to the WASI bridge, which must not read an observer's
// decline (folded into `StdIOPipe.write`'s result) as a refused delivery.

type DeliverChunk = (pipe: StdIOPipe, chunk: Uint8Array | string) => boolean;

let deliverChunk: DeliverChunk | undefined;

/** Installed once, by `StdIOPipe`'s static initializer. */
export function provideStdIOPipeDelivery(deliver: DeliverChunk): void {
  deliverChunk = deliver;
}

/**
 * Writes `chunk` to `pipe` exactly as `pipe.write(chunk)` does, observers
 * included, and returns whether it was delivered: a pending read took it, the
 * readable queue holds it, or the exclusive consumer accepted it. Only a
 * closed pipe or a refusing consumer leaves a chunk undelivered; an observer
 * that declines makes `write` return false but does not undo the delivery.
 */
export function deliverToStdIOPipe(
  pipe: StdIOPipe,
  chunk: Uint8Array | string,
): boolean {
  if (!deliverChunk) throw new Error("StdIOPipe is not loaded");
  return deliverChunk(pipe, chunk);
}
