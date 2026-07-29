import { createHash } from "node:crypto";

export function validateConformanceTextBytes(
  bytes: Uint8Array,
  context: string
): void {
  if (bytes.length === 0) {
    fail(`${context}: file is empty`);
  }
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    fail(`${context}: UTF-8 BOM is forbidden`);
  }
  if (bytes.includes(0x0D)) {
    fail(`${context}: CR bytes are forbidden`);
  }
  if (bytes.at(-1) !== 0x0A || bytes.at(-2) === 0x0A) {
    fail(`${context}: expected exactly one terminal LF`);
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(`${context}: invalid UTF-8`);
  }
  for (let index = 0, lineLength = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0A) {
      if (lineLength === 0) {
        fail(`${context}: blank lines are forbidden`);
      }
      lineLength = 0;
    } else {
      lineLength += 1;
    }
  }
}

export function parseConformanceJSON(
  bytes: Uint8Array,
  context: string
): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    fail(`${context}: invalid JSON: ${String(error)}`);
  }
}

export function conformanceSHA256(
  bytes: Uint8Array
): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fail(
  message: string
): never {
  throw new Error(`conformance fixture error: ${message}`);
}
