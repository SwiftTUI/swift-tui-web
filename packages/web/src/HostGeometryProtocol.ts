import { fitsWireGrid } from "./HostWireBudget.ts";

/** Input-only bound; it does not change the raster/image allocation budgets. */
export const MAX_HOST_CELL_PITCH = 8192;

export interface HostGeometryRequest {
  revision: number;
  columns: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
}

export function isGeometryRevision(
  value: unknown,
  allowAcknowledgement = false,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= (allowAcknowledgement ? 0 : 1)
  );
}

export function isHostGeometryRequest(request: HostGeometryRequest): boolean {
  return (
    isGeometryRevision(request.revision) &&
    request.columns > 0 &&
    request.rows > 0 &&
    fitsWireGrid(request.columns, request.rows) &&
    [request.cellWidth, request.cellHeight].every(
      (value) =>
        Number.isInteger(value) && value > 0 && value <= MAX_HOST_CELL_PITCH,
    )
  );
}

/** Called only after the producer has acknowledged geometryRevisions. */
export function encodeGeometryControlMessage(
  request: HostGeometryRequest,
): Uint8Array {
  if (!isHostGeometryRequest(request))
    throw new RangeError("Invalid host geometry request");
  return new TextEncoder().encode(
    `\u001egeometry:${request.revision}:${request.columns}:${request.rows}:${request.cellWidth}:${request.cellHeight}\n`,
  );
}
