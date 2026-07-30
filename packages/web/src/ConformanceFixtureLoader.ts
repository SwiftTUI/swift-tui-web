import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  conformanceSHA256,
  parseConformanceJSON,
  validateConformanceTextBytes,
} from "./ConformanceFixtureBytes.ts";
import { parseConformanceFixture } from "./ConformanceFixtureSchema.ts";
import {
  CONFORMANCE_FORMAT_VERSION,
  CONFORMANCE_KINDS,
  CONFORMANCE_MUTATION_CLASSES,
  CONFORMANCE_RUNNERS,
  CONFORMANCE_STAGES,
  type ConformanceCorpus,
  type ConformanceKind,
  type ConformanceManifest,
  type ConformanceManifestEntry,
  type ConformanceMutationClass,
  type ConformanceRunner,
  type ConformanceStage,
} from "./ConformanceFixtureTypes.ts";

export * from "./ConformanceFixtureTypes.ts";

export async function loadConformanceCorpus(
  directory: string,
  overrides: {
    manifestBytes?: Uint8Array;
    fixtureBytes?: Map<string, Uint8Array>;
  } = {}
): Promise<ConformanceCorpus> {
  const manifestBytes = overrides.manifestBytes
    ?? new Uint8Array(await readFile(join(directory, "conformance-manifest.json")));
  validateConformanceTextBytes(manifestBytes, "conformance-manifest.json");
  const manifest = parseManifest(
    parseConformanceJSON(manifestBytes, "conformance-manifest.json")
  );

  const fixtureBytes = overrides.fixtureBytes ?? await readFixtureBytes(directory);
  const expectedFiles = new Set(manifest.fixtures.map((entry) => entry.file));
  const actualFiles = new Set(fixtureBytes.keys());
  if (!setsEqual(expectedFiles, actualFiles)) {
    fail(
      `fixture census mismatch: expected ${JSON.stringify([...expectedFiles].sort())}, `
      + `got ${JSON.stringify([...actualFiles].sort())}`
    );
  }

  const manifestHash = conformanceSHA256(manifestBytes);
  const fixtures = new Map();
  for (const entry of manifest.fixtures) {
    const bytes = fixtureBytes.get(entry.file);
    if (!bytes) {
      fail(`${entry.file}: missing fixture body`);
    }
    fixtures.set(entry.file, parseConformanceFixture(entry, bytes, manifestHash));
  }
  return { manifestBytes, manifest, fixtures };
}

async function readFixtureBytes(
  directory: string
): Promise<Map<string, Uint8Array>> {
  const names = (await readdir(directory))
    .filter((name) => /^conformance-.*\.jsonl$/.test(name))
    .sort();
  const result = new Map<string, Uint8Array>();
  for (const name of names) {
    result.set(name, new Uint8Array(await readFile(join(directory, name))));
  }
  return result;
}

function parseManifest(
  value: unknown
): ConformanceManifest {
  const object = exactObject(value, ["formatVersion", "fixtures"], "manifest");
  if (object.formatVersion !== CONFORMANCE_FORMAT_VERSION) {
    fail(`manifest: unsupported formatVersion ${String(object.formatVersion)}`);
  }
  if (!Array.isArray(object.fixtures)) {
    fail("manifest.fixtures: expected array");
  }

  const entries = object.fixtures.map((fixture, index) => {
    const context = `manifest.fixtures[${index}]`;
    const item = exactObject(fixture, [
      "file",
      "scenario",
      "kind",
      "mutationClass",
      "bodySHA256",
      "requiresStage",
      "runners",
    ], context);
    const entry: ConformanceManifestEntry = {
      file: requiredString(item.file, `${context}.file`),
      scenario: requiredString(item.scenario, `${context}.scenario`),
      kind: enumValue(item.kind, CONFORMANCE_KINDS, `${context}.kind`),
      mutationClass: enumValue(
        item.mutationClass,
        CONFORMANCE_MUTATION_CLASSES,
        `${context}.mutationClass`
      ),
      bodySHA256: requiredString(item.bodySHA256, `${context}.bodySHA256`),
      requiresStage: enumValue(
        item.requiresStage,
        CONFORMANCE_STAGES,
        `${context}.requiresStage`
      ),
      runners: requiredArray(item.runners, `${context}.runners`).map(
        (runner, runnerIndex) => enumValue(
          runner,
          CONFORMANCE_RUNNERS,
          `${context}.runners[${runnerIndex}]`
        )
      ),
    };
    validateManifestEntry(entry, context);
    return entry;
  });

  const files = entries.map((entry) => entry.file);
  if (files.join("\0") !== [...files].sort().join("\0")) {
    fail("manifest: fixtures must be sorted by filename");
  }
  if (new Set(files).size !== files.length) {
    fail("manifest: duplicate fixture filename");
  }
  if (new Set(entries.map((entry) => entry.scenario)).size !== entries.length) {
    fail("manifest: duplicate scenario");
  }
  return { formatVersion: 1, fixtures: entries };
}

function validateManifestEntry(
  entry: ConformanceManifestEntry,
  context: string
): void {
  if (!/^conformance-[a-z0-9-]+\.jsonl$/.test(entry.file)) {
    fail(`${context}.file: expected conformance-*.jsonl`);
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.scenario)) {
    fail(`${context}.scenario: expected kebab-case`);
  }
  if (!/^[0-9a-f]{64}$/.test(entry.bodySHA256)) {
    fail(`${context}.bodySHA256: expected lowercase SHA-256`);
  }
  const indexes = entry.runners.map((runner) => CONFORMANCE_RUNNERS.indexOf(runner));
  if (
    new Set(entry.runners).size !== entry.runners.length
    || indexes.some((index, offset) => offset > 0 && index <= indexes[offset - 1]!)
  ) {
    fail(`${context}.runners: expected duplicate-free canonical order`);
  }

  const expected = manifestBinding(entry.mutationClass, entry.kind);
  if (
    entry.kind !== expected.kind
    || entry.requiresStage !== expected.stage
    || entry.runners.join("\0") !== expected.runners.join("\0")
  ) {
    fail(`${context}: mutation binding does not match kind, stage, and runners`);
  }
}

function manifestBinding(
  mutationClass: ConformanceMutationClass,
  actualKind: ConformanceKind
): {
  kind: ConformanceKind;
  stage: ConformanceStage;
  runners: ConformanceRunner[];
} {
  const allRecord: ConformanceRunner[] = [
    "swift-reference",
    "web-canvas",
    "web-dom",
    "android",
  ];
  switch (mutationClass) {
  case "control":
  case "baseline-loss":
  case "epoch-reanchor":
    return { kind: "record", stage: "s1", runners: allRecord };
  case "image-forget":
    return actualKind === "record"
      ? {
        kind: "record",
        stage: "s2",
        runners: ["swift-reference", "android"],
      }
      : {
        kind: "web-painter",
        stage: "s2",
        runners: ["web-canvas", "web-dom"],
      };
  case "image-decode-failure":
    return { kind: "web-painter", stage: "s2", runners: ["web-canvas"] };
  case "unknown-token":
    return {
      kind: "record",
      stage: "s1",
      runners: ["web-canvas", "web-dom", "android"],
    };
  case "android-delivery-commit":
    return {
      kind: "android-abi",
      stage: "s3a",
      runners: ["swift-android-abi"],
    };
  case "websocket-detached-backlog":
    return {
      kind: "websocket-channel",
      stage: "s3b",
      runners: ["swift-websocket-channel"],
    };
  case "style-append":
    return { kind: "record", stage: "s3d", runners: allRecord };
  }
}

function exactObject(
  value: unknown,
  keys: string[],
  context: string
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${context}: expected object`);
  }
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (actual.join("\0") !== expected.join("\0")) {
    fail(`${context}: expected keys ${expected.join(",")}; got ${actual.join(",")}`);
  }
  return object;
}

function requiredArray(
  value: unknown,
  context: string
): unknown[] {
  if (!Array.isArray(value)) {
    fail(`${context}: expected array`);
  }
  return value;
}

function requiredString(
  value: unknown,
  context: string
): string {
  if (typeof value !== "string") {
    fail(`${context}: expected string`);
  }
  return value;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  values: T,
  context: string
): T[number] {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    fail(`${context}: unknown value ${String(value)}`);
  }
  return value as T[number];
}

function setsEqual<T>(
  lhs: Set<T>,
  rhs: Set<T>
): boolean {
  return lhs.size === rhs.size && [...lhs].every((item) => rhs.has(item));
}

function fail(
  message: string
): never {
  throw new Error(`conformance fixture error: ${message}`);
}
