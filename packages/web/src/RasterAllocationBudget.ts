/** Backing stores are capped independently of cell-grid and compressed bytes. */
export const MAX_RASTER_DIMENSION = 8192;
export const MAX_RASTER_PIXELS = 16 * 1024 * 1024;

export function boundedCanvasSize(
  cssWidth: number,
  cssHeight: number,
  scale: number,
): {
  width: number;
  height: number;
  scale: number;
} {
  if (
    ![cssWidth, cssHeight, scale].every(
      (value) => Number.isFinite(value) && value > 0,
    )
  ) {
    return { width: 1, height: 1, scale: 1 };
  }
  const requestedWidth = Math.ceil(cssWidth * scale);
  const requestedHeight = Math.ceil(cssHeight * scale);
  if (
    requestedWidth <= MAX_RASTER_DIMENSION &&
    requestedHeight <= MAX_RASTER_DIMENSION &&
    requestedWidth * requestedHeight <= MAX_RASTER_PIXELS
  ) {
    return { width: requestedWidth, height: requestedHeight, scale };
  }
  const boundedScale = Math.min(
    scale,
    MAX_RASTER_DIMENSION / cssWidth,
    MAX_RASTER_DIMENSION / cssHeight,
    Math.sqrt(MAX_RASTER_PIXELS / cssWidth / cssHeight),
  );
  return {
    width: Math.max(1, Math.floor(cssWidth * boundedScale)),
    height: Math.max(1, Math.floor(cssHeight * boundedScale)),
    scale: boundedScale,
  };
}
