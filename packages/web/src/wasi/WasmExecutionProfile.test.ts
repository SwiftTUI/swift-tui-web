import { expect, test } from "bun:test";
import { validateWasmExecutionProfile } from "./WasmExecutionProfile.ts";

const utf8 = new TextEncoder();
const name = (text: string) => [text.length, ...utf8.encode(text)];
const section = (id: number, bytes: number[]) => [id, bytes.length, ...bytes];

function fixture(
  options: {
    memory?: boolean;
    start?: boolean;
    argument?: boolean;
    result?: boolean;
    automaticStart?: boolean;
    sharedMemory?: boolean;
    importName?: string;
    importModule?: string;
  } = {},
): Uint8Array {
  const hasImport = options.importName !== undefined;
  const exports = [
    ...(options.memory === false ? [] : [[...name("memory"), 2, 0]]),
    ...(options.start === false
      ? []
      : [[...name("_start"), 0, Number(hasImport)]]),
  ];
  return new Uint8Array([
    0,
    97,
    115,
    109,
    1,
    0,
    0,
    0,
    ...section(1, [
      1,
      0x60,
      ...(options.argument ? [1, 0x7f] : [0]),
      ...(options.result ? [1, 0x7f] : [0]),
    ]),
    ...(hasImport
      ? section(2, [
          1,
          ...name(options.importModule ?? "wasi_snapshot_preview1"),
          ...name(options.importName ?? ""),
          0,
          0,
        ])
      : []),
    ...section(3, [1, 0]),
    ...section(5, [1, ...(options.sharedMemory ? [3, 1, 1] : [0, 1])]),
    ...section(7, [exports.length, ...exports.flat()]),
    ...(options.automaticStart ? section(8, [0]) : []),
    ...section(10, [
      1,
      ...(options.result ? [4, 0, 0x41, 0, 0x0b] : [2, 0, 0x0b]),
    ]),
  ]);
}

async function check(bytes: Uint8Array): Promise<void> {
  validateWasmExecutionProfile(await WebAssembly.compile(bytes), bytes);
}

test("accepts a WASI command without running its entry point", async () => {
  await check(fixture());
  await check(fixture({ importName: "fd_write" }));
});

test.each([
  [{ memory: false }, "missingExport"],
  [{ start: false }, "missingExport"],
  [{ argument: true }, "startSignature"],
  [{ result: true }, "startSignature"],
  [{ automaticStart: true }, "automatic start"],
  [{ sharedMemory: true }, "unshared wasm32"],
  [{ importName: "unsupported_operation" }, "unsupportedImport"],
  [{ importName: "fd_write", importModule: "env" }, "unsupportedImport"],
  [{ importName: "toString" }, "unsupportedImport"],
] as const)("rejects incompatible declarations %j", async (options, code) => {
  await expect(check(fixture(options))).rejects.toThrow(code);
});
