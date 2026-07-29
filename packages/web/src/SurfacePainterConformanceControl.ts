/**
 * Internal test-only seams shared by the S5 runner and the real painters.
 * This module is intentionally absent from every package entry point.
 */
import type { WebHostSurfaceImage } from "./WebHostSurfaceTransport.ts";

export interface CanvasSurfacePainterConformanceControl {
  evictImages(ids: readonly string[]): void;
  visibleImageIDs(images: readonly WebHostSurfaceImage[]): string[];
}

export interface DomSurfacePainterConformanceControl {
  evictImages(ids: readonly string[]): void;
  visibleImageIDs(): string[];
}

const canvasControls = new WeakMap<object, CanvasSurfacePainterConformanceControl>();
const domControls = new WeakMap<object, DomSurfacePainterConformanceControl>();

export function registerCanvasSurfacePainterConformanceControl(
  painter: object,
  control: CanvasSurfacePainterConformanceControl
): void {
  canvasControls.set(painter, control);
}

export function canvasSurfacePainterConformanceControl(
  painter: object
): CanvasSurfacePainterConformanceControl {
  const control = canvasControls.get(painter);
  if (!control) {
    throw new Error("Canvas conformance control is not registered");
  }
  return control;
}

export function registerDomSurfacePainterConformanceControl(
  painter: object,
  control: DomSurfacePainterConformanceControl
): void {
  domControls.set(painter, control);
}

export function domSurfacePainterConformanceControl(
  painter: object
): DomSurfacePainterConformanceControl {
  const control = domControls.get(painter);
  if (!control) {
    throw new Error("DOM conformance control is not registered");
  }
  return control;
}
