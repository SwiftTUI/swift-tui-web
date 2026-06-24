import type {
  WebHostScrollRegion,
} from "./WebHostSurfaceTransport.ts";
import type { CellLocation } from "./InputEventEncoder.ts";

/**
 * The cell-grid geometry a pointer hit-test needs: the surface's bounding
 * client rect (the canvas's, falling back to the terminal mount's), the cell
 * dimensions, and the grid extent in cells. The host snapshots this per event.
 */
export interface PointerGeometryMetrics {
  rect?: { left: number; top: number } | null;
  cellWidth: number;
  cellHeight: number;
  columns: number;
  rows: number;
}

/**
 * Converts a pointer event to fractional cell coordinates, clamped to the
 * grid. Returns `undefined` when the pointer is outside the cell grid (in the
 * sub-cell margin/gutter), so the host can leave the event unhandled.
 */
export function cellLocationForEvent(
  event: MouseEvent,
  metrics: PointerGeometryMetrics
): CellLocation | undefined {
  const location = rawCellLocationForEvent(event, metrics);
  if (!location) {
    return undefined;
  }

  const cellX = Math.floor(location.x);
  const cellY = Math.floor(location.y);
  if (cellX < 0 || cellY < 0 || cellX >= metrics.columns || cellY >= metrics.rows) {
    return undefined;
  }
  return location;
}

/**
 * Converts a pointer event to fractional cell coordinates *without* clamping to
 * the grid. Used while a pointer is captured (drag) so the host keeps tracking
 * the gesture even when it strays outside the surface bounds.
 */
export function rawCellLocationForEvent(
  event: MouseEvent,
  metrics: PointerGeometryMetrics
): CellLocation | undefined {
  const rect = metrics.rect;
  if (!rect) {
    return undefined;
  }

  const x = (event.clientX - rect.left) / metrics.cellWidth;
  const y = (event.clientY - rect.top) / metrics.cellHeight;
  return { x, y };
}

/**
 * Whether any scrollable region under `location` can still scroll in the
 * wheel's direction. Mirrors the Swift host's scroll hit-test: a region
 * qualifies when its viewport contains the cell AND it has remaining headroom
 * in the delta's direction. Used by "chain" wheel mode to decide capture vs.
 * fall-through. With no published `scrollRegions`, nothing can scroll, so the
 * wheel chains to the page (a scene with no ScrollView stays fully passive).
 */
export function wheelTargetCanScroll(
  regions: readonly WebHostScrollRegion[] | undefined,
  location: CellLocation,
  deltaX: number,
  deltaY: number
): boolean {
  if (!regions || regions.length === 0) {
    return false;
  }

  const cellX = Math.floor(location.x);
  const cellY = Math.floor(location.y);
  // Any region under the pointer that can move in this direction qualifies —
  // this is what lets an outer ScrollView take over when an inner one is at
  // its edge (nested scroll), and chains to the page only when none can.
  for (const region of regions) {
    const [rx, ry, rw, rh] = region.rect;
    if (cellX < rx || cellY < ry || cellX >= rx + rw || cellY >= ry + rh) {
      continue;
    }
    if (regionCanScrollInDirection(region, deltaX, deltaY)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a published scroll region has remaining headroom in the wheel's
 * direction, recomputing the per-direction extent from offset/content/viewport.
 * Mirrors SwiftTUI's clamp (`min(max(0, offset), max(0, content - viewport))`)
 * so the host and the app agree on "at edge". Wheel sign convention matches the
 * app: `deltaY > 0` scrolls down (offset grows toward the content bottom).
 * Diagonal wheels qualify if either axis has headroom.
 */
function regionCanScrollInDirection(
  region: WebHostScrollRegion,
  deltaX: number,
  deltaY: number
): boolean {
  const [, , viewportWidth, viewportHeight] = region.rect;
  const [offsetX, offsetY] = region.offset;
  const [contentWidth, contentHeight] = region.content;
  const maxX = Math.max(0, contentWidth - viewportWidth);
  const maxY = Math.max(0, contentHeight - viewportHeight);
  const clampedX = Math.min(Math.max(0, offsetX), maxX);
  const clampedY = Math.min(Math.max(0, offsetY), maxY);

  if (deltaY > 0 && clampedY < maxY) {
    return true;
  }
  if (deltaY < 0 && clampedY > 0) {
    return true;
  }
  if (deltaX > 0 && clampedX < maxX) {
    return true;
  }
  if (deltaX < 0 && clampedX > 0) {
    return true;
  }
  return false;
}
