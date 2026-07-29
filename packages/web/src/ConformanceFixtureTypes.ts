export const CONFORMANCE_FORMAT_VERSION = 1;
export const WEB_CONFORMANCE_RUNNERS = ["web-canvas", "web-dom"] as const;
export const WEB_CONFORMANCE_ACTIVE_STAGES = ["s1", "s2"] as const;

export const CONFORMANCE_RUNNERS = [
  "swift-reference",
  "web-canvas",
  "web-dom",
  "android",
  "swift-android-abi",
  "swift-websocket-channel",
] as const;
export const CONFORMANCE_KINDS = [
  "record",
  "web-painter",
  "android-abi",
  "websocket-channel",
] as const;
export const CONFORMANCE_STAGES = ["s1", "s2", "s3a", "s3b", "s3d"] as const;
export const CONFORMANCE_MUTATION_CLASSES = [
  "control",
  "baseline-loss",
  "image-forget",
  "image-decode-failure",
  "unknown-token",
  "epoch-reanchor",
  "android-delivery-commit",
  "websocket-detached-backlog",
  "style-append",
] as const;

export type ConformanceRunner = typeof CONFORMANCE_RUNNERS[number];
export type WebConformanceRunner = typeof WEB_CONFORMANCE_RUNNERS[number];
export type ConformanceKind = typeof CONFORMANCE_KINDS[number];
export type ConformanceStage = typeof CONFORMANCE_STAGES[number];
export type ConformanceMutationClass =
  typeof CONFORMANCE_MUTATION_CLASSES[number];

export interface ConformanceManifestEntry {
  file: string;
  scenario: string;
  kind: ConformanceKind;
  mutationClass: ConformanceMutationClass;
  bodySHA256: string;
  requiresStage: ConformanceStage;
  runners: ConformanceRunner[];
}

export interface ConformanceManifest {
  formatVersion: 1;
  fixtures: ConformanceManifestEntry[];
}

export interface ConformanceGridCell {
  column: number;
  text: string;
  span: number;
}

export interface ConformanceGridRow {
  row: number;
  cells: ConformanceGridCell[];
}

export interface ConformanceStyleRun {
  row: number;
  startColumn: number;
  text: string;
  span: number;
  resolvedStyle: Record<string, unknown>;
}

export interface ConformanceExpectation {
  rows: ConformanceGridRow[];
  imagesVisible: string[];
  resyncRequests: unknown[];
  styleRuns?: ConformanceStyleRun[];
}

export type ConformanceStep =
  | { type: "emit"; record: string }
  | { type: "drop"; count: number }
  | { type: "evictImages"; ids: string[] }
  | { type: "reconnect"; capsAfter?: number }
  | { type: "decodeFailure"; id: string; outcomes: Array<"failure" | "success"> }
  | { type: "androidABI"; value: Record<string, unknown> }
  | { type: "channel"; value: Record<string, unknown> }
  | {
    type: "expect";
    value: Record<string, unknown>;
    expectation?: ConformanceExpectation;
  };

export interface ConformanceFixture {
  entry: ConformanceManifestEntry;
  steps: ConformanceStep[];
  droppedEmitIndexes: Set<number>;
}

export interface ConformanceCorpus {
  manifestBytes: Uint8Array;
  manifest: ConformanceManifest;
  fixtures: Map<string, ConformanceFixture>;
}
