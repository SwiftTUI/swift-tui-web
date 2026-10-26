import { provideStdIOPipeDelivery } from "./StdIOPipeDelivery.ts";

export class StdIOPipe implements AsyncIterable<Uint8Array> {
  static {
    // Installs the bridge's delivery report (StdIOPipeDelivery.ts).
    provideStdIOPipeDelivery((pipe, chunk) => pipe.writeChunk(chunk).delivered);
  }

  private readonly chunks: Uint8Array[] = [];
  private readonly waiters: Array<(value: IteratorResult<Uint8Array>) => void> =
    [];
  private readonly listeners = new Set<(chunk: Uint8Array) => boolean | void>();
  private consumer?: (chunk: Uint8Array) => boolean | void;
  private closed = false;

  /** Bytes awaiting read()/async iteration or attachment of a consumer. */
  get bufferedBytes(): number {
    return this.chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  }

  /**
   * Returns false when the pipe is closed, the exclusive consumer refused the
   * chunk (or still refuses an earlier queued one), or an observer declined
   * it; a declined chunk is still delivered.
   */
  write(chunk: Uint8Array | string): boolean {
    const { delivered, observed } = this.writeChunk(chunk);
    return delivered && observed;
  }

  /**
   * Delivery and observation, reported apart: `delivered` is false only for a
   * closed pipe or a refusing consumer, `observed` when an observer declined.
   */
  private writeChunk(chunk: Uint8Array | string): {
    delivered: boolean;
    observed: boolean;
  } {
    if (this.closed) return { delivered: false, observed: true };
    const bytes =
      typeof chunk === "string"
        ? new TextEncoder().encode(chunk)
        : new Uint8Array(chunk);
    let delivered = true;
    const waiter = this.waiters.shift();
    if (waiter) {
      // A pending read takes the chunk; it is not also queued. Observers
      // still see it below: they watch writes, not queue consumption.
      waiter({ done: false, value: bytes });
    } else {
      // Chunks the consumer refused when it attached go first, in order.
      if (this.consumer && this.chunks.length > 0) this.offerQueued();
      if (!this.consumer) this.chunks.push(bytes);
      // While the consumer still refuses a queued chunk, a later chunk would
      // overtake it, so it is refused too.
      else if (this.chunks.length > 0) delivered = false;
      else delivered = this.consumer(bytes) !== false;
    }
    let observed = true;
    for (const listener of this.listeners) {
      if (listener(bytes) === false) observed = false;
    }
    return { delivered, observed };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()?.({ done: true, value: undefined as never });
    }
  }

  async read(): Promise<Uint8Array | undefined> {
    if (this.consumer)
      throw new Error("The pipe already has an exclusive consumer");
    const next = this.chunks.shift();
    if (next) return next;
    if (this.closed) return undefined;
    return await new Promise<Uint8Array | undefined>((resolve) => {
      this.waiters.push((result) =>
        resolve(result.done ? undefined : result.value),
      );
    });
  }

  /** Observe future writes; observation does not consume the readable queue. */
  subscribe(listener: (chunk: Uint8Array) => boolean | void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Consume queued and future bytes without retaining a duplicate read history.
   * This is exclusive with another consumer or a pending read. Detaching hands
   * future bytes back to the readable queue. Observers remain independent.
   * A queued chunk the consumer refuses stays queued with every chunk after
   * it, and the next write offers them again before its own chunk.
   */
  consume(listener: (chunk: Uint8Array) => boolean | void): () => void {
    if (this.consumer || this.waiters.length > 0)
      throw new Error(
        "The pipe already has an exclusive consumer or pending read",
      );
    this.consumer = listener;
    this.offerQueued();
    return () => {
      if (this.consumer === listener) this.consumer = undefined;
    };
  }

  /**
   * Hands queued chunks to the consumer in order, stopping at the first one it
   * refuses, which stays at the head of the queue. Those chunks were reported
   * delivered when they were queued, so the pipe is the only one holding them.
   */
  private offerQueued(): void {
    const consumer = this.consumer;
    while (consumer && this.consumer === consumer) {
      const chunk = this.chunks.shift();
      if (!chunk) return;
      if (consumer(chunk) === false) {
        this.chunks.unshift(chunk);
        return;
      }
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    while (true) {
      const next = await this.read();
      if (!next) return;
      yield next;
    }
  }
}
