export function exactObject(
  value: unknown,
  keys: string[],
  context: string
): Record<string, unknown> {
  const object = requiredObject(value, context);
  exactKeys(object, keys, context);
  return object;
}

export function exactKeys(
  object: Record<string, unknown>,
  keys: string[],
  context: string
): void {
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (actual.join("\0") !== expected.join("\0")) {
    fail(`${context}: expected keys ${expected.join(",")}; got ${actual.join(",")}`);
  }
}

export function requiredObject(
  value: unknown,
  context: string
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${context}: expected object`);
  }
  return value as Record<string, unknown>;
}

export function requiredArray(
  value: unknown,
  context: string
): unknown[] {
  if (!Array.isArray(value)) {
    fail(`${context}: expected array`);
  }
  return value;
}

export function requiredString(
  value: unknown,
  context: string
): string {
  if (typeof value !== "string") {
    fail(`${context}: expected string`);
  }
  return value;
}

export function requiredNonemptyString(
  value: unknown,
  context: string
): string {
  const string = requiredString(value, context);
  if (string.length === 0) {
    fail(`${context}: expected nonempty string`);
  }
  return string;
}

export function stringArray(
  value: unknown,
  context: string
): string[] {
  return requiredArray(value, context).map((item, index) =>
    requiredString(item, `${context}[${index}]`)
  );
}

export function enumValue<const T extends readonly string[]>(
  value: unknown,
  values: T,
  context: string
): T[number] {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    fail(`${context}: unknown value ${String(value)}`);
  }
  return value as T[number];
}

export function nonnegativeInteger(
  value: unknown,
  context: string
): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`${context}: expected nonnegative safe integer`);
  }
  return value as number;
}

export function positiveInteger(
  value: unknown,
  context: string
): number {
  const integer = nonnegativeInteger(value, context);
  if (integer === 0) {
    fail(`${context}: expected positive integer`);
  }
  return integer;
}

export function nullableNonnegativeInteger(
  value: unknown,
  context: string
): number | null {
  return value === null ? null : nonnegativeInteger(value, context);
}

export function nullablePositiveInteger(
  value: unknown,
  context: string
): number | null {
  return value === null ? null : positiveInteger(value, context);
}

export function safeSum(
  lhs: number,
  rhs: number,
  context: string
): number {
  const result = lhs + rhs;
  if (!Number.isSafeInteger(result)) {
    fail(`${context}: integer overflow`);
  }
  return result;
}

export function stableJSON(
  value: unknown
): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJSON).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJSON(object[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function fail(
  message: string
): never {
  throw new Error(`conformance fixture error: ${message}`);
}
