import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  conformanceSHA256,
} from "./ConformanceFixtureBytes.ts";
import {
  WEB_CONFORMANCE_ACTIVE_STAGES,
  WEB_CONFORMANCE_RUNNERS,
  loadConformanceCorpus,
  type ConformanceExpectation,
  type ConformanceFixture,
  type ConformanceManifestEntry,
} from "./ConformanceFixtureLoader.ts";
import { parseConformanceFixture } from "./ConformanceFixtureSchema.ts";
import {
  assertWebConformanceObservation,
  runWebConformanceFixture,
  type WebConformanceObservation,
} from "./WebSurfaceConformanceHarness.ts";

const fixtureDirectory = join(
  import.meta.dir,
  "../../../Fixtures/Transport"
);

describe("host-wire conformance corpus", () => {
  test("loads the full ten-body census including host-only fixtures", async () => {
    const corpus = await loadConformanceCorpus(fixtureDirectory);

    expect(corpus.manifest.fixtures).toHaveLength(10);
    expect(corpus.fixtures.size).toBe(10);
    expect(corpus.manifest.fixtures.map((entry) => entry.file)).toEqual([
      "conformance-android-delivery-commit.jsonl",
      "conformance-baseline-loss.jsonl",
      "conformance-control.jsonl",
      "conformance-epoch-reanchor.jsonl",
      "conformance-image-decode-failure.jsonl",
      "conformance-image-forget-record.jsonl",
      "conformance-image-forget-web-painter.jsonl",
      "conformance-style-append.jsonl",
      "conformance-unknown-token.jsonl",
      "conformance-websocket-detached-backlog.jsonl",
    ]);
    // The mirror is the full census; only the two host-only stages are
    // inapplicable to a web runner, and skipping them is allowed solely because
    // their file, manifest entry, and body hash are all present locally.
    expect(
      corpus.manifest.fixtures.filter((entry) =>
        !WEB_CONFORMANCE_ACTIVE_STAGES.includes(
          entry.requiresStage as "s1" | "s2" | "s3d"
        )
      ).map((entry) => entry.requiresStage)
    ).toEqual(["s3a", "s3b"]);
    // S3d landed, so the append fixture is part of the active census rather
    // than forbidden from it.
    expect(
      corpus.manifest.fixtures.filter((entry) => entry.requiresStage === "s3d")
        .map((entry) => entry.scenario)
    ).toEqual(["style-append-splices-onto-the-retained-table"]);
  });

  for (const runner of WEB_CONFORMANCE_RUNNERS) {
    test(`${runner} executes every applicable active fixture`, async () => {
      const corpus = await loadConformanceCorpus(fixtureDirectory);
      const expected = corpus.manifest.fixtures.filter((entry) =>
        entry.runners.includes(runner)
        && WEB_CONFORMANCE_ACTIVE_STAGES.includes(
          entry.requiresStage as "s1" | "s2" | "s3d"
        )
      );
      const executed: string[] = [];

      for (const entry of expected) {
        const fixture = corpus.fixtures.get(entry.file);
        expect(fixture).toBeDefined();
        const result = await runWebConformanceFixture(fixture!, runner);
        executed.push(result.scenario);
        expect(result.expectations.length).toBeGreaterThan(0);
      }

      expect(executed).toEqual(expected.map((entry) => entry.scenario));
    });
  }

  test("Canvas decode plans reject exhaustion and leftovers", async () => {
    const corpus = await loadConformanceCorpus(fixtureDirectory);
    const fixture = corpus.fixtures.get(
      "conformance-image-decode-failure.jsonl"
    )!;
    const exhausted = structuredClone(fixture);
    const exhaustedPlan = exhausted.steps.find(
      (step) => step.type === "decodeFailure"
    );
    if (exhaustedPlan?.type !== "decodeFailure") {
      throw new Error("decode plan missing");
    }
    exhaustedPlan.outcomes = ["failure"];
    await expect(
      runWebConformanceFixture(exhausted, "web-canvas")
    ).rejects.toThrow(/after plan exhaustion/);

    const leftover = structuredClone(fixture);
    const leftoverPlan = leftover.steps.find(
      (step) => step.type === "decodeFailure"
    );
    if (leftoverPlan?.type !== "decodeFailure") {
      throw new Error("decode plan missing");
    }
    leftoverPlan.outcomes = ["success", "success"];
    await expect(
      runWebConformanceFixture(leftover, "web-canvas")
    ).rejects.toThrow(/unconsumed outcomes/);
  });

  test("Canvas reports unique eligible current image attachments", async () => {
    const imageID = "png:duplicate";
    const fixture = syntheticFixture([
      {
        emit: surfaceRecord({
          version: 2,
          epoch: 501,
          gen: 1,
          sequence: 1,
          width: 1,
          height: 1,
          styles: [null],
          rows: [[[0, " ", 1, 0]]],
          images: [
            {
              id: imageID,
              format: "png",
              bounds: [0, 0, 1, 1],
              visibleBounds: [0, 0, 1, 1],
              scalingMode: "stretch",
              dataBase64: "QUJD",
            },
            {
              id: imageID,
              format: "png",
              bounds: [0, 0, 1, 1],
              visibleBounds: [0, 0, 1, 1],
              scalingMode: "stretch",
              dataBase64: "QUJD",
            },
          ],
        }),
      },
      {
        expect: {
          rows: [
            { row: 0, cells: [{ column: 0, text: " ", span: 1 }] },
          ],
          imagesVisible: [imageID],
          resyncRequests: [],
        },
      },
      {
        emit: surfaceRecord({
          version: 2,
          epoch: 501,
          gen: 2,
          sequence: 2,
          width: 1,
          height: 1,
          styles: [null],
          rows: [[[0, " ", 1, 0]]],
          images: [
            {
              id: imageID,
              format: "png",
              bounds: [0, 0, 0, 1],
              visibleBounds: [0, 0, 1, 1],
              scalingMode: "stretch",
            },
          ],
        }),
      },
      {
        expect: {
          rows: [
            { row: 0, cells: [{ column: 0, text: " ", span: 1 }] },
          ],
          imagesVisible: [],
          resyncRequests: [],
        },
      },
    ], {
      kind: "web-painter",
      mutationClass: "image-forget",
      runners: ["web-canvas", "web-dom"],
    }) as ConformanceFixture;

    const result = await runWebConformanceFixture(fixture, "web-canvas");
    expect(result.expectations.map((value) => value.imagesVisible)).toEqual([
      [imageID],
      [],
    ]);
  });
});

describe("host-wire conformance integrity and schema teeth", () => {
  test("rejects manifest hash, body hash, and hashed-body corruption independently", async () => {
    const bytes = await readCorpusBytes();
    const fixtureName = "conformance-control.jsonl";
    const original = bytes.fixtures.get(fixtureName)!;
    const originalText = new TextDecoder().decode(original);
    // Both hashes are read out of the fixture header rather than pinned as
    // literals here: a hard-coded hash makes every canonical re-record red in
    // a mirror that is otherwise byte-correct, which says nothing about the
    // integrity check this test exists to prove.
    const header = JSON.parse(originalText.slice(0, originalText.indexOf("\n"))) as {
      manifestSHA256: string;
      bodySHA256: string;
    };

    for (const corruptedText of [
      replaceFirst(
        originalText,
        header.manifestSHA256,
        flipLeadingHexDigit(header.manifestSHA256)
      ),
      replaceFirst(
        originalText,
        header.bodySHA256,
        flipLeadingHexDigit(header.bodySHA256)
      ),
      replaceFirst(originalText, '\\"A\\"', '\\"X\\"'),
    ]) {
      const fixtures = new Map(bytes.fixtures);
      fixtures.set(fixtureName, new TextEncoder().encode(corruptedText));
      await expect(loadConformanceCorpus(fixtureDirectory, {
        manifestBytes: bytes.manifest,
        fixtureBytes: fixtures,
      })).rejects.toThrow();
    }
  });

  test("rejects missing and extra mirror bodies", async () => {
    const bytes = await readCorpusBytes();
    const missing = new Map(bytes.fixtures);
    missing.delete("conformance-control.jsonl");
    await expect(loadConformanceCorpus(fixtureDirectory, {
      manifestBytes: bytes.manifest,
      fixtureBytes: missing,
    })).rejects.toThrow(/census/);

    const extra = new Map(bytes.fixtures);
    extra.set("conformance-extra.jsonl", bytes.fixtures.values().next().value!);
    await expect(loadConformanceCorpus(fixtureDirectory, {
      manifestBytes: bytes.manifest,
      fixtureBytes: extra,
    })).rejects.toThrow(/census/);
  });

  test("rejects BOM, CR, blank/double terminal LF, and invalid UTF-8", async () => {
    const bytes = await readCorpusBytes();
    const fixtureName = "conformance-control.jsonl";
    const original = bytes.fixtures.get(fixtureName)!;
    const variants = [
      concatBytes(new Uint8Array([0xEF, 0xBB, 0xBF]), original),
      replaceByte(original, 0x0A, 0x0D),
      concatBytes(original, new Uint8Array([0x0A])),
      concatBytes(original.slice(0, -1), new Uint8Array([0x0A, 0x0A])),
      concatBytes(original.slice(0, -1), new Uint8Array([0xFF, 0x0A])),
    ];
    for (const variant of variants) {
      const fixtures = new Map(bytes.fixtures);
      fixtures.set(fixtureName, variant);
      await expect(loadConformanceCorpus(fixtureDirectory, {
        manifestBytes: bytes.manifest,
        fixtureBytes: fixtures,
      })).rejects.toThrow();
    }
  });

  test("rejects unknown manifest fields, stages, and noncanonical runner order", async () => {
    const bytes = await readCorpusBytes();
    const manifest = JSON.parse(new TextDecoder().decode(bytes.manifest)) as {
      fixtures: Array<Record<string, unknown>>;
      formatVersion: number;
      future?: boolean;
    };
    const mutations: Array<(value: typeof manifest) => void> = [
      (value) => {
        value.future = true;
      },
      (value) => {
        value.fixtures[0]!.requiresStage = "s99";
      },
      (value) => {
        const runnerList = value.fixtures[1]!.runners as string[];
        [runnerList[0], runnerList[1]] = [runnerList[1]!, runnerList[0]!];
      },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(manifest);
      mutate(changed);
      await expect(loadConformanceCorpus(fixtureDirectory, {
        manifestBytes: new TextEncoder().encode(`${JSON.stringify(changed)}\n`),
        fixtureBytes: bytes.fixtures,
      })).rejects.toThrow();
    }
  });

  test("binds adjacent drops backwards and refuses to cross a barrier", () => {
    const emitA = { emit: "\u001Esurface:{}\n" };
    const emitB = { emit: "\u001Esurface:{\"version\":2}\n" };
    const expectation = {
      expect: {
        rows: [],
        imagesVisible: [],
        resyncRequests: [],
      },
    };
    const valid = syntheticFixture([
      emitA,
      emitB,
      { drop: 1 },
      { drop: 1 },
      expectation,
    ]);
    expect([...valid.droppedEmitIndexes].sort()).toEqual([0, 1]);

    expect(() => syntheticFixture([
      emitA,
      expectation,
      { drop: 1 },
    ])).toThrow(/barrier/);
  });

  test("validates inactive Android labels and channel token lifecycle before execution", () => {
    expect(() => syntheticFixture([
      { androidABI: { action: "copy", label: "future", capacity: 1 } },
      { expect: { androidDeliveries: [] } },
    ], {
      kind: "android-abi",
      mutationClass: "android-delivery-commit",
      requiresStage: "s3a",
      runners: ["swift-android-abi"],
    })).toThrow(/missing or forward label/);

    expect(() => syntheticFixture([
      { channel: { action: "clientChunk", token: 2, bytesBase64: "" } },
      channelExpectation(),
    ], {
      kind: "websocket-channel",
      mutationClass: "websocket-detached-backlog",
      requiresStage: "s3b",
      runners: ["swift-websocket-channel"],
    })).toThrow(/unknown\/future token/);
  });

  test("derives inactive channel record metadata from each raw occurrence", () => {
    const fullRaw = surfaceRecord({
      version: 2,
      epoch: 7,
      gen: 1,
      sequence: 1,
      width: 1,
      height: 1,
      styles: [null],
      rows: [[[0, " ", 1, 0]]],
      images: [],
    });
    const deltaRaw = surfaceRecord({
      version: 3,
      encoding: "delta",
      epoch: 7,
      gen: 2,
      baselineGen: 1,
      sequence: 2,
      width: 1,
      height: 1,
      styles: [null],
      deltaRows: [[0, [[0, " ", 1, 0]]]],
      images: [],
      damage: {
        textRows: [[0, [[0, 1]]]],
        requiresFullTextRepaint: false,
        requiresFullGraphicsReplay: false,
      },
    });
    const channelEntry: Partial<ConformanceManifestEntry> = {
      kind: "websocket-channel",
      mutationClass: "websocket-detached-backlog",
      requiresStage: "s3b",
      runners: ["swift-websocket-channel"],
    };
    const invalidMetadata = [
      {
        raw: fullRaw,
        kind: "delta",
        epoch: 7,
        gen: 1,
        baselineGen: null,
      },
      {
        raw: deltaRaw,
        kind: "full",
        epoch: 7,
        gen: 2,
        baselineGen: 1,
      },
      {
        raw: "\u001EruntimeIssue:{\"message\":\"detached\"}\n",
        kind: "non-surface",
        epoch: 7,
        gen: null,
        baselineGen: null,
      },
    ];

    for (const record of invalidMetadata) {
      expect(() => syntheticFixture([
        channelExpectation({ deliveredRecords: [record] }),
      ], channelEntry)).toThrow(/metadata does not match raw record/);
    }

    const fullRecord = {
      raw: fullRaw,
      kind: "full",
      epoch: 7,
      gen: 1,
      baselineGen: null,
    };
    expect(() => syntheticFixture([
      channelExpectation({
        deliveredRecords: [fullRecord],
        suppressedSurfaceRecords: [fullRecord],
      }),
    ], channelEntry)).toThrow(/both delivered and suppressed/);
  });
});

describe("host-wire conformance observable-axis teeth", () => {
  const expected: ConformanceExpectation = {
    rows: [
      {
        row: 0,
        cells: [
          { column: 0, text: "A", span: 1 },
          { column: 2, text: "界", span: 2 },
        ],
      },
      { row: 2, cells: [{ column: 1, text: "Z", span: 1 }] },
    ],
    imagesVisible: ["image-a", "image-b"],
    resyncRequests: [
      { scope: "images", ids: ["image-a", "image-b"] },
      { scope: "keyframe" },
    ],
    styleRuns: [
      {
        row: 0,
        startColumn: 0,
        text: "A",
        span: 1,
        resolvedStyle: { fg: "#E05757FF" },
      },
      {
        row: 0,
        startColumn: 2,
        text: "界",
        span: 2,
        resolvedStyle: { fg: "#5BA3FFFF" },
      },
    ],
  };

  const corruptions: Array<[string, (value: WebConformanceObservation) => void]> = [
    ["row count", (value) => void value.rows.pop()],
    ["cell count", (value) => void value.rows[0]!.cells.pop()],
    ["row position", (value) => value.rows[0]!.row += 1],
    ["column", (value) => value.rows[0]!.cells[0]!.column += 1],
    ["text", (value) => value.rows[0]!.cells[0]!.text = "B"],
    ["positive span", (value) => value.rows[0]!.cells[0]!.span = 0],
    ["gap presence", (value) => value.rows[0]!.cells[1]!.column = 1],
    ["gap width", (value) => value.rows[0]!.cells[1]!.column += 1],
    ["image ID", (value) => value.imagesVisible[0] = "image-z"],
    ["image count", (value) => void value.imagesVisible.pop()],
    ["request scope", (value) => value.resyncRequests[0] = { scope: "keyframe" }],
    ["request IDs", (value) => {
      value.resyncRequests[0] = { scope: "images", ids: ["image-b"] };
    }],
    ["request ID ordering", (value) => {
      value.resyncRequests[0] = {
        scope: "images",
        ids: ["image-b", "image-a"],
      };
    }],
    ["request order", (value) => value.resyncRequests.reverse()],
    ["request count", (value) => void value.resyncRequests.pop()],
    ["style position", (value) => value.styleRuns![0]!.startColumn += 1],
    ["style span", (value) => value.styleRuns![0]!.span += 1],
    ["style text", (value) => value.styleRuns![0]!.text = "B"],
    ["style gap boundary", (value) => value.styleRuns![1]!.startColumn -= 1],
    ["resolved style", (value) => {
      value.styleRuns![0]!.resolvedStyle = { fg: "#61C67BFF" };
    }],
  ];

  for (const [axis, corrupt] of corruptions) {
    test(`rejects corrupted ${axis}`, () => {
      const actual = structuredClone(expected) as WebConformanceObservation;
      corrupt(actual);
      expect(() => assertWebConformanceObservation(expected, actual)).toThrow();
    });
  }
});

async function readCorpusBytes(): Promise<{
  manifest: Uint8Array;
  fixtures: Map<string, Uint8Array>;
}> {
  const manifest = new Uint8Array(
    await readFile(join(fixtureDirectory, "conformance-manifest.json"))
  );
  const fixtures = new Map<string, Uint8Array>();
  for (const name of (await readdir(fixtureDirectory)).sort()) {
    if (/^conformance-.*\.jsonl$/.test(name)) {
      fixtures.set(name, new Uint8Array(await readFile(join(fixtureDirectory, name))));
    }
  }
  return { manifest, fixtures };
}

function flipLeadingHexDigit(
  hash: string
): string {
  return (hash[0] === "6" ? "7" : "6") + hash.slice(1);
}

function replaceFirst(
  value: string,
  search: string,
  replacement: string
): string {
  const index = value.indexOf(search);
  if (index < 0) {
    throw new Error(`test replacement missing ${search}`);
  }
  return value.slice(0, index) + replacement + value.slice(index + search.length);
}

function concatBytes(
  lhs: Uint8Array,
  rhs: Uint8Array
): Uint8Array {
  const result = new Uint8Array(lhs.length + rhs.length);
  result.set(lhs);
  result.set(rhs, lhs.length);
  return result;
}

function replaceByte(
  value: Uint8Array,
  search: number,
  replacement: number
): Uint8Array {
  const result = value.slice();
  const index = result.indexOf(search);
  if (index < 0) {
    throw new Error(`test byte replacement missing ${search}`);
  }
  result[index] = replacement;
  return result;
}

function syntheticFixture(
  steps: unknown[],
  overrides: Partial<ConformanceManifestEntry> = {}
) {
  const body = new TextEncoder().encode(
    `${steps.map((step) => JSON.stringify(step)).join("\n")}\n`
  );
  const manifestHash = "a".repeat(64);
  const bodySHA256 = conformanceSHA256(body);
  const header = new TextEncoder().encode(
    `${JSON.stringify({
      formatVersion: 1,
      manifestSHA256: manifestHash,
      bodySHA256,
    })}\n`
  );
  const entry: ConformanceManifestEntry = {
    file: "conformance-synthetic.jsonl",
    scenario: "synthetic",
    kind: "record",
    mutationClass: "control",
    bodySHA256,
    requiresStage: "s1",
    runners: ["swift-reference", "web-canvas", "web-dom", "android"],
    ...overrides,
  };
  return parseConformanceFixture(
    entry,
    concatBytes(header, body),
    manifestHash
  );
}

function channelExpectation(
  overrides: Record<string, unknown> = {}
): unknown {
  return {
    expect: {
      deliveredRecords: [],
      suppressedSurfaceRecords: [],
      detachedNonSurfaceBacklog: { count: 0, bytes: 0 },
      refreshRequestCount: 0,
      capsProcessedCount: 0,
      ignoredStaleCallbackCount: 0,
      acceptedClientInputs: [],
      discardedInboundChunks: [],
      parser: { token: 1, bufferedBytes: 0 },
      connection: {
        currentToken: 1,
        lastIssuedToken: 1,
        phase: "active",
        sceneInputFinished: false,
      },
      ...overrides,
    },
  };
}

function surfaceRecord(
  payload: Record<string, unknown>
): string {
  return `\u001Esurface:${JSON.stringify(payload)}\n`;
}
