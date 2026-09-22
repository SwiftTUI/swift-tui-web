import { HOST_WIRE_MAX_RECORD_BYTES } from "./HostWireBudget.ts";
import { MAX_RASTER_DIMENSION, MAX_RASTER_PIXELS } from "./RasterAllocationBudget.ts";

/** Read container dimensions before handing compressed bytes to a bitmap decoder. */
export function admitsImageBytes(bytes: Uint8Array): boolean {
  const size = imageSize(bytes);
  return size !== undefined && admitsImageSize(...size);
}

export function admitsImageSize(width: number, height: number): boolean {
  return Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0
    && width <= MAX_RASTER_DIMENSION && height <= MAX_RASTER_DIMENSION
    && width * height <= MAX_RASTER_PIXELS;
}

export function admitsImagePayload(payload: string): boolean {
  if (payload.length > HOST_WIRE_MAX_RECORD_BYTES) return false;
  try {
    const binary = atob(payload);
    return admitsImageBytes(Uint8Array.from(binary, character => character.charCodeAt(0)));
  } catch {
    return false;
  }
}

function imageSize(bytes: Uint8Array): [number, number] | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length >= 24 && view.getUint32(0) === 0x89504e47
    && view.getUint32(4) === 0x0d0a1a0a && view.getUint32(12) === 0x49484452) {
    return [view.getUint32(16), view.getUint32(20)];
  }
  if (bytes.length >= 10 && view.getUint32(0) === 0x47494638
    && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return [view.getUint16(6, true), view.getUint16(8, true)];
  }
  if (bytes.length < 4 || view.getUint16(0) !== 0xffd8) return undefined;
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) return undefined;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xda || marker === 0xd9) return undefined;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return undefined;
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > bytes.length) return undefined;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (length < 8) return undefined;
      return [view.getUint16(offset + 5), view.getUint16(offset + 3)];
    }
    offset += length;
  }
  return undefined;
}
