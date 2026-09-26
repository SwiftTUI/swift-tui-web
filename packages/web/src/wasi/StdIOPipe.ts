export class StdIOPipe implements AsyncIterable<Uint8Array> {
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

  write(chunk: Uint8Array | string): boolean {
    if (this.closed) return false;
    const bytes =
      typeof chunk === "string"
        ? new TextEncoder().encode(chunk)
        : new Uint8Array(chunk);
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value: bytes });
      return true;
    }
    if (!this.consumer) this.chunks.push(bytes);
    let accepted = this.consumer?.(bytes) !== false;
    for (const listener of this.listeners) {
      if (listener(bytes) === false) accepted = false;
    }
    return accepted;
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
   */
  consume(listener: (chunk: Uint8Array) => boolean | void): () => void {
    if (this.consumer || this.waiters.length > 0)
      throw new Error(
        "The pipe already has an exclusive consumer or pending read",
      );
    this.consumer = listener;
    for (const chunk of this.chunks.splice(0)) listener(chunk);
    return () => {
      if (this.consumer === listener) this.consumer = undefined;
    };
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    while (true) {
      const next = await this.read();
      if (!next) return;
      yield next;
    }
  }
}
