/** Cross-host allocation policy; mirrored by Swift and Kotlin. */
export const HOST_WIRE_MAX_RECORD_BYTES = 4 * 1024 * 1024;
export const HOST_WIRE_MAX_GRID_DIMENSION = 1024;
export const HOST_WIRE_MAX_GRID_CELLS = 65536;
export const HOST_WIRE_MAX_IMAGES = 1024;
export const HOST_WIRE_MAX_METADATA_ENTRIES = 65536;
export const HOST_WIRE_MAX_CELL_TEXT_BYTES = 256;
export const HOST_WIRE_MAX_STYLE_BYTES = 1024;
export const HOST_WIRE_MAX_JSON_DEPTH = 32;

/** Counts UTF-8 without allocating an encoded copy; stops as soon as over budget. */
export function fitsUTF8(text: string, limit: number): boolean {
  let bytes = 0;
  for (const scalar of text) {
    const code = scalar.codePointAt(0)!;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (bytes > limit) return false;
  }
  return true;
}

export function fitsWireGrid(width: number, height: number): boolean {
  return (
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width >= 0 &&
    height >= 0 &&
    width <= HOST_WIRE_MAX_GRID_DIMENSION &&
    height <= HOST_WIRE_MAX_GRID_DIMENSION &&
    width * height <= HOST_WIRE_MAX_GRID_CELLS
  );
}

export function wireStyleLimit(width: number, height: number): number {
  return Math.max(1024, width * height + 1);
}

/** Eight units per JSON value plus UTF-8 bytes in keys and string values.
 * This avoids JSON serializer differences (number spelling and slash escaping).
 */
export function fitsStyleContent(style: unknown): boolean {
  let remaining = HOST_WIRE_MAX_STYLE_BYTES;
  const chargeString = (text: string): boolean => {
    for (const scalar of text) {
      const code = scalar.codePointAt(0)!;
      remaining -=
        code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
      if (remaining < 0) return false;
    }
    return true;
  };
  const visit = (value: unknown): boolean => {
    remaining -= 8;
    if (remaining < 0) return false;
    if (typeof value === "string") return chargeString(value);
    if (Array.isArray(value)) return value.every(visit);
    if (value !== null && typeof value === "object") {
      return Object.entries(value).every(
        ([key, item]) => chargeString(key) && visit(item),
      );
    }
    return true;
  };
  return visit(style);
}

/** Lexical check before JSON.parse; braces inside strings do not count. */
export function fitsJSONDepth(text: string): boolean {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const character of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "[" || character === "{") {
      if (++depth > HOST_WIRE_MAX_JSON_DEPTH) return false;
    } else if (character === "]" || character === "}") depth--;
  }
  return true;
}

/** Runs only on structurally valid frames, before retaining or expanding them. */
export function fitsSurfaceBudget(frame: {
  width: number;
  height: number;
  styles: unknown[];
  stylesBase?: number;
  rows?: Array<Array<[number, string, number, number]>>;
  deltaRows?: Array<[number, Array<[number, string, number, number]>]>;
  images?: Array<{ id: string; pixelSize?: [number, number] }>;
  accessibilityTree?: unknown[];
  accessibilityAnnouncements?: unknown[];
  scrollRegions?: unknown[];
  linkTargets?: string[];
  links?: Array<[number, Array<[number, number, number]>]>;
  damage?: { textRows: Array<[number, Array<[number, number]>]> };
  preferredGridWidth?: number;
  preferredGridHeight?: number;
}): boolean {
  const { width, height } = frame;
  if (!fitsWireGrid(width, height)) return false;
  if (
    frame.styles.length + (frame.stylesBase ?? 0) >
    wireStyleLimit(width, height)
  )
    return false;
  if (!frame.styles.every(fitsStyleContent)) return false;
  if (
    (frame.rows?.length ?? 0) > height ||
    (frame.deltaRows?.length ?? 0) > height
  )
    return false;
  const validCells = (
    cells: Array<[number, string, number, number]>,
  ): boolean => {
    if (cells.length > width) return false;
    let end = 0;
    for (const [x, text, span, style] of cells) {
      if (
        !Number.isInteger(x) ||
        !Number.isInteger(span) ||
        x < end ||
        span < 1 ||
        x > width - span ||
        !fitsUTF8(text, HOST_WIRE_MAX_CELL_TEXT_BYTES) ||
        !Number.isInteger(style) ||
        style < 0 ||
        style >= frame.styles.length + (frame.stylesBase ?? 0)
      )
        return false;
      end = x + span;
    }
    return true;
  };
  if (frame.rows && !frame.rows.every(validCells)) return false;
  const seen = new Set<number>();
  for (const [y, cells] of frame.deltaRows ?? []) {
    if (y < 0 || y >= height || seen.has(y) || !validCells(cells)) return false;
    seen.add(y);
  }
  if ((frame.images?.length ?? 0) > HOST_WIRE_MAX_IMAGES) return false;
  for (const image of frame.images ?? []) {
    if (!fitsUTF8(image.id, 1024)) return false;
    if (image.pixelSize) {
      const [w, h] = image.pixelSize;
      if (
        !Number.isInteger(w) ||
        !Number.isInteger(h) ||
        w < 0 ||
        h < 0 ||
        w > 8192 ||
        h > 8192 ||
        w * h > 16 * 1024 * 1024
      )
        return false;
    }
  }
  for (const entries of [
    frame.accessibilityTree,
    frame.accessibilityAnnouncements,
    frame.scrollRegions,
    frame.linkTargets,
  ]) {
    if ((entries?.length ?? 0) > HOST_WIRE_MAX_METADATA_ENTRIES) return false;
  }
  for (const dimension of [
    frame.preferredGridWidth,
    frame.preferredGridHeight,
  ]) {
    if (dimension !== undefined && dimension > HOST_WIRE_MAX_GRID_DIMENSION)
      return false;
  }
  if (
    !fitsWireGrid(frame.preferredGridWidth ?? 0, frame.preferredGridHeight ?? 0)
  )
    return false;
  if (
    (frame.links?.length ?? 0) > height ||
    (frame.damage?.textRows.length ?? 0) > height
  )
    return false;
  for (const rows of [frame.links, frame.damage?.textRows]) {
    const seenRows = new Set<number>();
    for (const [y, ranges] of rows ?? []) {
      if (
        !Number.isInteger(y) ||
        y < 0 ||
        y >= height ||
        seenRows.has(y) ||
        ranges.length > width
      )
        return false;
      seenRows.add(y);
      let end = 0;
      for (const range of ranges) {
        const [start, lengthOrEnd] = range;
        const stop = range.length === 3 ? start + lengthOrEnd : lengthOrEnd;
        if (
          !Number.isInteger(start) ||
          !Number.isInteger(stop) ||
          start < 0 ||
          (range.length === 3 && start < end) ||
          stop < start ||
          stop > width
        )
          return false;
        end = stop;
      }
    }
  }
  return true;
}
