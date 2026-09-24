import {
  type HostGeometryRequest,
  isHostGeometryRequest,
} from "./HostGeometryProtocol.ts";
import type { WebHostSurfaceFrame } from "./WebHostSurfaceTransport.ts";

/** Bounded correlation state; no frame history or growing request table. */
export class HostGeometrySession {
  private acknowledged = false;
  private sentRevision?: number;
  private latest?: Readonly<HostGeometryRequest>;
  private presentedRevision?: number;
  private hasPresentedFrame = false;

  get negotiated(): boolean {
    return this.acknowledged;
  }
  get allowsPointer(): boolean {
    return this.hasPresentedFrame;
  }
  get pointerRevision(): number | undefined {
    return this.acknowledged ? this.presentedRevision : undefined;
  }

  request(geometry: HostGeometryRequest): void {
    if (!isHostGeometryRequest(geometry))
      throw new RangeError("Invalid host geometry request");
    if (this.latest && geometry.revision < this.latest.revision)
      throw new RangeError("Geometry revision cannot regress");
    if (
      this.latest &&
      geometry.revision === this.latest.revision &&
      ["columns", "rows", "cellWidth", "cellHeight"].some(
        (key) =>
          this.latest![key as keyof HostGeometryRequest] !==
          geometry[key as keyof HostGeometryRequest],
      )
    )
      throw new RangeError("A geometry revision cannot name different metrics");
    this.latest = Object.freeze({ ...geometry });
  }

  observe(frame: WebHostSurfaceFrame): void {
    if (frame.geometryRevision === 0) this.acknowledged = true;
  }

  takeRequest(): Readonly<HostGeometryRequest> | undefined {
    if (
      !this.acknowledged ||
      !this.latest ||
      this.sentRevision === this.latest.revision
    )
      return undefined;
    this.sentRevision = this.latest.revision;
    return this.latest;
  }

  canPresent(frame: WebHostSurfaceFrame | undefined): boolean {
    if (!this.acknowledged) return frame?.geometryRevision === undefined;
    return (
      !!frame &&
      !!this.latest &&
      frame.geometryRevision === this.latest.revision &&
      frame.width === this.latest.columns &&
      frame.height === this.latest.rows
    );
  }

  didPresent(frame: WebHostSurfaceFrame | undefined): void {
    if (!this.canPresent(frame))
      throw new Error("Presentation does not match requested geometry");
    this.presentedRevision = frame?.geometryRevision;
    this.hasPresentedFrame = frame !== undefined;
  }

  resetConnection(): void {
    this.acknowledged = false;
    this.sentRevision = undefined;
    this.presentedRevision = undefined;
    this.hasPresentedFrame = false;
  }
}
