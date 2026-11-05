import { HOST_WIRE_MAX_JSON_DEPTH } from "./HostWireBudget.ts";

type ObjectKey = string | number;
type ObjectScope = {
  depth: number;
  keys: ObjectKey[];
  overflow?: Set<ObjectKey>;
};
/** Decoder-owned scratch storage. Only empty key slots survive a record;
 * no wire strings or large-object sets survive success or refusal. */
export class WireJSONAdmission {
  private readonly objects: ObjectScope[] = [];

  check(text: string, startIndex = 0): "admitted" | "depth" | "ambiguous" {
    try {
      return this.scan(text, startIndex);
    } finally {
      for (const object of this.objects) {
        object.keys.length = 0;
        object.overflow = undefined;
      }
    }
  }

  /** Bound nesting, duplicate keys and binary64 overflow before the single
   * JSON.parse. The parser remains responsible for the complete JSON grammar. */
  private scan(
    text: string,
    startIndex: number,
  ): "admitted" | "depth" | "ambiguous" {
    if (
      !Number.isInteger(startIndex) ||
      startIndex < 0 ||
      startIndex > text.length
    )
      return "ambiguous";
    let depth = 0;
    // Cell tuples contain no keys. Track object scopes only; array nesting needs
    // a counter, without a push/pop allocation path for every raster cell.
    // Reuse a scope slot for sibling objects. Small objects avoid a hash table;
    // promotion bounds comparisons for large or adversarial object vocabularies.
    const objects = this.objects;
    let objectCount = 0;
    for (let i = startIndex; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 34) {
        const start = ++i;
        let escaped = false;
        for (; i < text.length; i++) {
          const next = text.charCodeAt(i);
          if (next === 92) {
            escaped = true;
            i++;
          } else if (next === 34) break;
        }
        if (i >= text.length) return "ambiguous";
        let end = i + 1;
        while (end < text.length) {
          const space = text.charCodeAt(end);
          if (space !== 32 && space !== 9 && space !== 10 && space !== 13)
            break;
          end++;
        }
        if (text.charCodeAt(end) === 58) {
          const object = objects[objectCount - 1];
          if (!object || object.depth !== depth) return "ambiguous";
          let key: ObjectKey;
          if (escaped) {
            const decoded = decodeEscapedKey(text.slice(start, i));
            if (decoded === undefined) return "ambiguous";
            key = objectKey(decoded, 0, decoded.length);
          } else key = objectKey(text, start, i);
          if (object.overflow) {
            if (object.overflow.has(key)) return "ambiguous";
            object.overflow.add(key);
          } else {
            if (object.keys.includes(key)) return "ambiguous";
            if (object.keys.length === 16) {
              object.overflow = new Set(object.keys);
              object.overflow.add(key);
            } else object.keys.push(key);
          }
        }
      } else if (c === 123 || c === 91) {
        if (++depth > HOST_WIRE_MAX_JSON_DEPTH) return "depth";
        if (c === 123) {
          const object = objects[objectCount];
          if (object) object.depth = depth;
          else objects.push({ depth, keys: [], overflow: undefined });
          objectCount++;
        }
      } else if (c === 125 || c === 93) {
        if (depth === 0) return "ambiguous";
        const object = objects[objectCount - 1];
        if (c === 125) {
          if (!object || object.depth !== depth) return "ambiguous";
          object.keys.length = 0;
          object.overflow = undefined;
          objectCount--;
        } else if (object?.depth === depth) return "ambiguous";
        depth--;
      } else if (c === 45 || (c >= 48 && c <= 57)) {
        const start = i;
        let exponent = false;
        while (i < text.length) {
          const digit = text.charCodeAt(i);
          if (digit === 69 || digit === 101) exponent = true;
          else if (
            digit !== 43 &&
            digit !== 45 &&
            digit !== 46 &&
            (digit < 48 || digit > 57)
          )
            break;
          i++;
        }
        if (
          (exponent || i - start > 308) &&
          !Number.isFinite(Number(text.slice(start, i)))
        )
          return "ambiguous";
        i--;
      }
    }
    return depth === 0 ? "admitted" : "ambiguous";
  }
}

export function checkWireJSON(
  text: string,
  startIndex = 0,
): "admitted" | "depth" | "ambiguous" {
  return new WireJSONAdmission().check(text, startIndex);
}

export function admitsWireJSON(text: string): boolean {
  return checkWireJSON(text) === "admitted";
}

// Empty, one-unit and two-unit keys fit disjoint exact integer ranges.
// This avoids allocating strings for compact style vocabularies. Longer names
// remain strings; escaped aliases use the same representation after decoding.
function objectKey(text: string, start: number, end: number): ObjectKey {
  switch (end - start) {
    case 0:
      return 0;
    case 1:
      return 1 + text.charCodeAt(start);
    case 2:
      return (
        65537 + text.charCodeAt(start) * 65536 + text.charCodeAt(start + 1)
      );
    default:
      return text.slice(start, end);
  }
}

// Keep escape replacement state out of the ordinary scanner activation. Most
// wire keys are unescaped; decoding still compares their exact UTF-16 spelling.
function decodeEscapedKey(key: string): string | undefined {
  let invalid = false;
  const decoded = key.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, code: string) => {
    if (code[0] === "u")
      return String.fromCharCode(Number.parseInt(code.slice(1), 16));
    switch (code) {
      case '"':
        return '"';
      case "\\":
        return "\\";
      case "/":
        return "/";
      case "b":
        return "\b";
      case "f":
        return "\f";
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      default:
        invalid = true;
        return "";
    }
  });
  return invalid ? undefined : decoded;
}
