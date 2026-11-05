import { normalizeWireUInt64 } from "./WireUInt64.ts";

/** Session-owned requests. Reset retires IDs; it never makes an old ID reusable. */
export class AccessibilityRequests {
  private next = 0n;
  private readonly outstanding = new Map<
    bigint,
    { target: string; expires: number }
  >();

  constructor(private readonly now = () => performance.now()) {}

  issue(target: string): bigint {
    this.prune();
    if (this.next === 18446744073709551615n)
      throw new Error("accessibility request IDs exhausted");
    const id = ++this.next;
    if (this.outstanding.size >= 256)
      this.outstanding.delete(this.outstanding.keys().next().value!);
    this.outstanding.set(id, { target, expires: this.now() + 30_000 });
    return id;
  }

  settle(response: { requestID: string; target: string }): boolean {
    this.prune();
    const canonical = normalizeWireUInt64(response.requestID);
    if (canonical === undefined) return false;
    const id = BigInt(canonical);
    if (this.outstanding.get(id)?.target !== response.target) return false;
    this.outstanding.delete(id);
    return true;
  }

  has(id: bigint): boolean {
    this.prune();
    return this.outstanding.has(id);
  }
  cancel(id: bigint): void {
    this.outstanding.delete(id);
  }
  reset(): void {
    this.outstanding.clear();
  }
  retainTargets(targets: Set<string>): void {
    for (const [id, request] of this.outstanding)
      if (!targets.has(request.target)) this.outstanding.delete(id);
    this.prune();
  }
  private prune(): void {
    const now = this.now();
    for (const [id, request] of this.outstanding)
      if (request.expires <= now) this.outstanding.delete(id);
  }
}
