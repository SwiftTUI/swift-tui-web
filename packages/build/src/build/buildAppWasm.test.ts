import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageBrowserValidatedWasm } from "./buildAppWasm.ts";

const wasmHeader = [0, 97, 115, 109, 1, 0, 0, 0];
// A command with one memory and a () -> () entry point, not an empty module.
const minimalWasmBytes = new Uint8Array([
  ...wasmHeader,
  1,
  4,
  1,
  0x60,
  0,
  0,
  3,
  2,
  1,
  0,
  5,
  3,
  1,
  0,
  1,
  7,
  19,
  2,
  6,
  ...new TextEncoder().encode("memory"),
  2,
  0,
  6,
  ...new TextEncoder().encode("_start"),
  0,
  0,
  10,
  4,
  1,
  2,
  0,
  0x0b,
]);

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

test("falls back to the original wasm when strip tooling throws", async () => {
  const fixture = await createFixture();
  const warnings: string[] = [];

  await packageBrowserValidatedWasm({
    optimize: async () => {},
    sourceWasmPath: fixture.sourceWasmPath,
    outputWasmPath: fixture.outputWasmPath,
    strip: async () => {
      throw new Error("missing llvm-objcopy");
    },
    onWarning: (warning) => warnings.push(warning),
  });

  expect(await Bun.file(fixture.outputWasmPath).bytes()).toEqual(
    minimalWasmBytes,
  );
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("keeping unstripped wasm");
  expect(warnings[0]).toContain("missing llvm-objcopy");
  await WebAssembly.compile(
    await Bun.file(fixture.outputWasmPath).arrayBuffer(),
  );
});

test("falls back to the original wasm when stripping corrupts the artifact", async () => {
  const fixture = await createFixture();
  const warnings: string[] = [];

  await packageBrowserValidatedWasm({
    optimize: async () => {},
    sourceWasmPath: fixture.sourceWasmPath,
    outputWasmPath: fixture.outputWasmPath,
    strip: async (wasmPath) => {
      await Bun.write(wasmPath, new Uint8Array([0x00, 0x61, 0x73, 0x6d]));
    },
    onWarning: (warning) => warnings.push(warning),
  });

  expect(await Bun.file(fixture.outputWasmPath).bytes()).toEqual(
    minimalWasmBytes,
  );
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain(
    "stripped wasm does not parse in browser WebAssembly",
  );
  await WebAssembly.compile(
    await Bun.file(fixture.outputWasmPath).arrayBuffer(),
  );
});

test("fails when the source wasm itself is not browser-parseable", async () => {
  const fixture = await createFixture(buildHugeFunctionTypeWasm(1001));

  await expect(
    packageBrowserValidatedWasm({
      optimize: async () => {},
      sourceWasmPath: fixture.sourceWasmPath,
      outputWasmPath: fixture.outputWasmPath,
      strip: async () => {},
    }),
  ).rejects.toThrow("generated wasm does not parse in browser WebAssembly");
  await expect(
    packageBrowserValidatedWasm({
      optimize: async () => {},
      sourceWasmPath: fixture.sourceWasmPath,
      outputWasmPath: fixture.outputWasmPath,
      strip: async () => {},
    }),
  ).rejects.toThrow("maxTypeParameterCount=1001");
  await expect(
    packageBrowserValidatedWasm({
      optimize: async () => {},
      sourceWasmPath: fixture.sourceWasmPath,
      outputWasmPath: fixture.outputWasmPath,
      strip: async () => {},
    }),
  ).rejects.toThrow("overBrowserLimitTypes=0");
});

test("uses optimized wasm when the raw compiler output is not browser-parseable", async () => {
  const fixture = await createFixture(buildHugeFunctionTypeWasm(1001));

  await packageBrowserValidatedWasm({
    optimize: async (wasmPath) => {
      await Bun.write(wasmPath, minimalWasmBytes);
    },
    sourceWasmPath: fixture.sourceWasmPath,
    outputWasmPath: fixture.outputWasmPath,
    strip: async () => {},
  });

  expect(await Bun.file(fixture.outputWasmPath).bytes()).toEqual(
    minimalWasmBytes,
  );
});

test("reports the optimization failure when the raw wasm is still invalid", async () => {
  const fixture = await createFixture(buildHugeFunctionTypeWasm(1001));

  await expect(
    packageBrowserValidatedWasm({
      optimize: async () => {
        throw new Error("missing wasm-opt");
      },
      sourceWasmPath: fixture.sourceWasmPath,
      outputWasmPath: fixture.outputWasmPath,
      strip: async () => {},
    }),
  ).rejects.toThrow("wasm optimization step failed: missing wasm-opt");
});

async function createFixture(
  sourceBytes: Uint8Array = minimalWasmBytes,
): Promise<{ sourceWasmPath: string; outputWasmPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "webhost-wasm-"));
  temporaryDirectories.push(directory);

  const sourceWasmPath = join(directory, "source.wasm");
  const outputWasmPath = join(directory, "output.wasm");
  await Bun.write(sourceWasmPath, sourceBytes);

  return {
    sourceWasmPath,
    outputWasmPath,
  };
}

function buildHugeFunctionTypeWasm(parameterCount: number): Uint8Array {
  const payload = [
    ...encodeUnsignedLEB128(1),
    0x60,
    ...encodeUnsignedLEB128(parameterCount),
    ...new Array<number>(parameterCount).fill(0x7f),
    0x00,
  ];

  return new Uint8Array([
    ...wasmHeader,
    0x01,
    ...encodeUnsignedLEB128(payload.length),
    ...payload,
  ]);
}

function encodeUnsignedLEB128(value: number): number[] {
  if (value < 0) {
    throw new Error("LEB128 values must be non-negative");
  }

  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (remaining !== 0);

  return bytes;
}

test("rejects a parseable empty module before packaging succeeds", async () => {
  const fixture = await createFixture(new Uint8Array(wasmHeader));
  await expect(
    packageBrowserValidatedWasm({
      ...fixture,
      optimize: async () => {},
      strip: async () => {},
    }),
  ).rejects.toThrow("wasi.profile.missingExport");
});
