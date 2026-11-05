import { HOST_WIRE_MAX_JSON_DEPTH } from "./HostWireBudget.ts";

/** Admission before the single JSON.parse: bound nesting, reject duplicate
 * keys (including escaped spellings), and reject binary64 overflow. JSON.parse
 * remains responsible for the complete JSON grammar. No object tree is built. */
export function checkWireJSON(
  text: string,
): "admitted" | "depth" | "ambiguous" {
  const keys: Array<Set<string> | undefined> = [];
  for (let i = 0; i < text.length; i++) {
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
      while (end < text.length && /[\t\n\r ]/.test(text[end]!)) end++;
      if (text.charCodeAt(end) === 58) {
        const object = keys[keys.length - 1];
        if (!object) return "ambiguous";
        let key = text.slice(start, i);
        if (escaped) {
          let invalid = false;
          key = key.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, code: string) => {
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
          if (invalid) return "ambiguous";
        }
        if (object.has(key)) return "ambiguous";
        object.add(key);
      }
    } else if (c === 123 || c === 91) {
      if (keys.length >= HOST_WIRE_MAX_JSON_DEPTH) return "depth";
      keys.push(c === 123 ? new Set() : undefined);
    } else if (c === 125 || c === 93) {
      if (!keys.length) return "ambiguous";
      keys.pop();
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
  return keys.length === 0 ? "admitted" : "ambiguous";
}

export function admitsWireJSON(text: string): boolean {
  return checkWireJSON(text) === "admitted";
}
