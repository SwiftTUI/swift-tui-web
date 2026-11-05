/** Decimal IDs remain strings: JavaScript numbers cannot represent UInt64. */
export function normalizeWireUInt64(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^[0-9]{1,20}$/.test(value)) return;
  const canonical = value.replace(/^0+(?=.)/, "");
  if (canonical.length === 20 && canonical > "18446744073709551615") return;
  return canonical;
}
