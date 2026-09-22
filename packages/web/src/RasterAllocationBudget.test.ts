import { expect, test } from "bun:test";
import { boundedCanvasSize, MAX_RASTER_DIMENSION, MAX_RASTER_PIXELS } from "./RasterAllocationBudget.ts";

test("backing-store allocation preserves ordinary DPR and bounds large grids before sizing canvas", () => {
  expect(boundedCanvasSize(800, 600, 2)).toEqual({ width: 1600, height: 1200, scale: 2 });
  expect(boundedCanvasSize(81, 41, 1.25)).toEqual({ width: 102, height: 52, scale: 1.25 });
  for (const [width, height, scale] of [[10240, 20480, 3], [1e100, 10, 2], [1, 1e100, 4]]) {
    const result = boundedCanvasSize(width, height, scale);
    expect(result.width).toBeLessThanOrEqual(MAX_RASTER_DIMENSION);
    expect(result.height).toBeLessThanOrEqual(MAX_RASTER_DIMENSION);
    expect(result.width * result.height).toBeLessThanOrEqual(MAX_RASTER_PIXELS);
    expect(result.scale).toBeGreaterThan(0);
  }
  expect(boundedCanvasSize(Infinity, 100, 2)).toEqual({ width: 1, height: 1, scale: 1 });
});
