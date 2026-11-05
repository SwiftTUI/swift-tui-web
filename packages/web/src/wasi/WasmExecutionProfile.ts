import { WASI } from "@bjorn3/browser_wasi_shim";

/** Startup-only checks for swifttui.wasi-command/1; never instantiates the app. */
export function validateWasmExecutionProfile(
  module: WebAssembly.Module,
  bytes: Uint8Array,
  imports: Record<string, unknown> = new WASI([], [], []).wasiImport,
): void {
  const exports = WebAssembly.Module.exports(module);
  for (const [name, kind] of [
    ["memory", "memory"],
    ["_start", "function"],
  ]) {
    if (!exports.some((entry) => entry.name === name && entry.kind === kind)) {
      throw new Error(
        `wasi.profile.missingExport: expected ${kind} export ${name}`,
      );
    }
  }
  for (const entry of WebAssembly.Module.imports(module)) {
    if (
      entry.module !== "wasi_snapshot_preview1" ||
      entry.kind !== "function" ||
      !Object.hasOwn(imports, entry.name) ||
      typeof imports[entry.name] !== "function"
    ) {
      throw new Error(
        `wasi.profile.unsupportedImport: ${entry.module}.${entry.name} (${entry.kind})`,
      );
    }
  }

  // The JS reflection API exposes export kinds but not function signatures or
  // memory width. Read only declarations after the engine has validated bytes.
  // This command profile uses flat core function types and one wasm32 memory.
  const reader = new DeclarationReader(bytes);
  reader.offset = 8;
  const types: boolean[] = [];
  const functions: number[] = [];
  let startType: number | undefined;
  let memories = 0;
  while (reader.offset < bytes.length) {
    const section = reader.byte();
    const size = reader.uint();
    const end = reader.offset + size;
    if (end > bytes.length) reader.fail("section bounds");
    if (section === 1) {
      const count = reader.uint();
      for (let i = 0; i < count; i++) {
        if (reader.byte() !== 0x60) reader.fail("non-function type");
        const parameters = reader.valueTypes();
        const results = reader.valueTypes();
        types.push(parameters === 0 && results === 0);
      }
    } else if (section === 2) {
      const count = reader.uint();
      for (let i = 0; i < count; i++) {
        reader.name();
        reader.name();
        if (reader.byte() !== 0) reader.fail("non-function import");
        functions.push(reader.uint());
      }
    } else if (section === 3) {
      const count = reader.uint();
      for (let i = 0; i < count; i++) functions.push(reader.uint());
    } else if (section === 5) {
      memories = reader.uint();
      for (let i = 0; i < memories; i++) {
        const flags = reader.uint();
        if (flags !== 0 && flags !== 1)
          reader.fail("memory must be unshared wasm32");
        reader.uint();
        if (flags === 1) reader.uint();
      }
    } else if (section === 7) {
      const count = reader.uint();
      for (let i = 0; i < count; i++) {
        const name = reader.name();
        const kind = reader.byte();
        const index = reader.uint();
        if (name === "_start" && kind === 0) startType = functions[index];
      }
    } else if (section === 8) {
      reader.fail("automatic start section; use the _start command export");
    }
    if (reader.offset > end) reader.fail("declaration bounds");
    reader.offset = end;
  }
  if (startType === undefined || !types[startType]) {
    throw new Error(
      "wasi.profile.startSignature: _start must have type () -> ()",
    );
  }
  if (memories !== 1) reader.fail("exactly one defined memory is required");
}

class DeclarationReader {
  offset = 0;
  constructor(private readonly bytes: Uint8Array) {}
  fail(detail: string): never {
    throw new Error(`wasi.profile.unsupportedModule: ${detail}`);
  }
  byte(): number {
    if (this.offset >= this.bytes.length)
      this.fail("unexpected end of declarations");
    return this.bytes[this.offset++];
  }
  uint(): number {
    let result = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const byte = this.byte();
      result += (byte & 0x7f) * 2 ** shift;
      if (!(byte & 0x80) && result <= 0xffffffff) return result;
    }
    return this.fail("invalid unsigned LEB128");
  }
  name(): string {
    const size = this.uint();
    const end = this.offset + size;
    if (end > this.bytes.length) this.fail("name bounds");
    const name = new TextDecoder().decode(
      this.bytes.subarray(this.offset, end),
    );
    this.offset = end;
    return name;
  }
  valueTypes(): number {
    const count = this.uint();
    for (let i = 0; i < count; i++) {
      if (![0x7f, 0x7e, 0x7d, 0x7c, 0x7b, 0x70, 0x6f].includes(this.byte())) {
        this.fail("unsupported value type");
      }
    }
    return count;
  }
}
