import {
  conformanceSHA256,
  parseConformanceJSON,
  validateConformanceTextBytes,
} from "./ConformanceFixtureBytes.ts";
import type {
  ConformanceExpectation,
  ConformanceFixture,
  ConformanceGridRow,
  ConformanceManifestEntry,
  ConformanceStep,
  ConformanceStyleRun,
} from "./ConformanceFixtureTypes.ts";
import { validateConformanceScenarioState } from "./ConformanceScenarioValidation.ts";
import {
  enumValue,
  exactKeys,
  exactObject,
  fail,
  nonnegativeInteger,
  nullableNonnegativeInteger,
  nullablePositiveInteger,
  positiveInteger,
  requiredArray,
  requiredNonemptyString,
  requiredObject,
  requiredString,
  safeSum,
  stableJSON,
  stringArray,
} from "./ConformanceSchemaPrimitives.ts";

export function parseConformanceFixture(
  entry: ConformanceManifestEntry,
  bytes: Uint8Array,
  manifestHash: string
): ConformanceFixture {
  validateConformanceTextBytes(bytes, entry.file);
  const firstLF = bytes.indexOf(0x0A);
  if (firstLF < 0) {
    fail(`${entry.file}: header line missing`);
  }
  const headerBytes = bytes.slice(0, firstLF);
  const bodyBytes = bytes.slice(firstLF + 1);
  const header = exactObject(parseConformanceJSON(headerBytes, `${entry.file}:header`), [
    "formatVersion",
    "manifestSHA256",
    "bodySHA256",
  ], `${entry.file}:header`);
  if (header.formatVersion !== 1) {
    fail(`${entry.file}: unsupported header formatVersion`);
  }
  if (header.manifestSHA256 !== manifestHash) {
    fail(`${entry.file}: manifest hash mismatch`);
  }
  if (
    header.bodySHA256 !== entry.bodySHA256
    || conformanceSHA256(bodyBytes) !== entry.bodySHA256
  ) {
    fail(`${entry.file}: body hash mismatch`);
  }

  const bodyText = new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes);
  const lines = bodyText.slice(0, -1).split("\n");
  const steps = lines.map((line, index) =>
    parseStep(JSON.parse(line) as unknown, entry, `${entry.file}:${index + 2}`)
  );
  validateConformanceScenarioState(entry, steps);
  const droppedEmitIndexes = resolveDrops(steps, entry.file);
  return { entry, steps, droppedEmitIndexes };
}

function parseStep(
  value: unknown,
  entry: ConformanceManifestEntry,
  context: string
): ConformanceStep {
  const object = requiredObject(value, context);
  const keys = Object.keys(object);
  if (keys.length !== 1) {
    fail(`${context}: expected exactly one step key`);
  }
  const key = keys[0]!;
  const payload = object[key];
  switch (key) {
  case "emit": {
    if (entry.kind === "android-abi") {
      fail(`${context}: emit is not legal for android-abi`);
    }
    const record = requiredString(payload, `${context}.emit`);
    validateEmittedRecord(record, entry.kind === "websocket-channel", context);
    return { type: "emit", record };
  }
  case "drop": {
    if (entry.kind !== "record" && entry.kind !== "web-painter") {
      fail(`${context}: drop is not legal for ${entry.kind}`);
    }
    return { type: "drop", count: positiveInteger(payload, `${context}.drop`) };
  }
  case "evictImages": {
    if (entry.kind !== "record" && entry.kind !== "web-painter") {
      fail(`${context}: evictImages is not legal for ${entry.kind}`);
    }
    const ids = stringArray(payload, `${context}.evictImages`);
    if (ids.length === 0 || new Set(ids).size !== ids.length) {
      fail(`${context}.evictImages: expected nonempty unique IDs`);
    }
    return { type: "evictImages", ids };
  }
  case "reconnect": {
    if (entry.kind === "android-abi") {
      fail(`${context}: reconnect is not legal for android-abi`);
    }
    const reconnect = requiredObject(payload, `${context}.reconnect`);
    if (entry.kind === "websocket-channel") {
      exactKeys(reconnect, ["capsAfter"], `${context}.reconnect`);
      return {
        type: "reconnect",
        capsAfter: nonnegativeInteger(reconnect.capsAfter, `${context}.capsAfter`),
      };
    }
    exactKeys(reconnect, [], `${context}.reconnect`);
    return { type: "reconnect" };
  }
  case "decodeFailure": {
    if (
      entry.kind !== "web-painter"
      || entry.mutationClass !== "image-decode-failure"
      || !entry.runners.includes("web-canvas")
    ) {
      fail(`${context}: decodeFailure is not applicable`);
    }
    const plan = exactObject(payload, ["id", "outcomes"], `${context}.decodeFailure`);
    const outcomes = requiredArray(plan.outcomes, `${context}.outcomes`).map(
      (outcome, index) =>
        enumValue(outcome, ["failure", "success"] as const, `${context}.outcomes[${index}]`)
    );
    if (outcomes.length === 0) {
      fail(`${context}.outcomes: expected nonempty array`);
    }
    return {
      type: "decodeFailure",
      id: requiredString(plan.id, `${context}.id`),
      outcomes,
    };
  }
  case "androidABI": {
    if (entry.kind !== "android-abi") {
      fail(`${context}: androidABI is not legal for ${entry.kind}`);
    }
    const action = requiredObject(payload, `${context}.androidABI`);
    validateAndroidAction(action, `${context}.androidABI`);
    return { type: "androidABI", value: action };
  }
  case "channel": {
    if (entry.kind !== "websocket-channel") {
      fail(`${context}: channel is not legal for ${entry.kind}`);
    }
    const action = requiredObject(payload, `${context}.channel`);
    validateChannelAction(action, `${context}.channel`);
    return { type: "channel", value: action };
  }
  case "expect": {
    const expectation = requiredObject(payload, `${context}.expect`);
    if (entry.kind === "record" || entry.kind === "web-painter") {
      return {
        type: "expect",
        value: expectation,
        expectation: parseRecordExpectation(expectation, entry, `${context}.expect`),
      };
    }
    if (entry.kind === "android-abi") {
      validateAndroidExpectation(expectation, `${context}.expect`);
    } else {
      validateChannelExpectation(expectation, `${context}.expect`);
    }
    return { type: "expect", value: expectation };
  }
  default:
    fail(`${context}: unknown step ${key}`);
  }
}

function parseRecordExpectation(
  value: Record<string, unknown>,
  entry: ConformanceManifestEntry,
  context: string
): ConformanceExpectation {
  const keys = ["rows", "imagesVisible", "resyncRequests"];
  if (entry.kind === "record" && "styleRuns" in value) {
    keys.push("styleRuns");
  }
  exactKeys(value, keys, context);
  const rows = parseGridRows(value.rows, `${context}.rows`);
  const imagesVisible = stringArray(value.imagesVisible, `${context}.imagesVisible`);
  if (
    imagesVisible.join("\0") !== [...imagesVisible].sort().join("\0")
    || new Set(imagesVisible).size !== imagesVisible.length
  ) {
    fail(`${context}.imagesVisible: expected sorted set`);
  }
  const resyncRequests = requiredArray(value.resyncRequests, `${context}.resyncRequests`);
  resyncRequests.forEach((request, index) =>
    validateResyncRequest(request, `${context}.resyncRequests[${index}]`)
  );
  const styleRuns = value.styleRuns === undefined
    ? undefined
    : parseStyleRuns(value.styleRuns, rows, `${context}.styleRuns`);
  return { rows, imagesVisible, resyncRequests, styleRuns };
}

function parseGridRows(
  value: unknown,
  context: string
): ConformanceGridRow[] {
  const rows = requiredArray(value, context);
  let previousRow = -1;
  return rows.map((row, rowIndex) => {
    const rowContext = `${context}[${rowIndex}]`;
    const object = exactObject(row, ["row", "cells"], rowContext);
    const rowNumber = nonnegativeInteger(object.row, `${rowContext}.row`);
    if (rowNumber <= previousRow) {
      fail(`${rowContext}.row: rows must be strictly ascending`);
    }
    previousRow = rowNumber;
    let previousEnd = 0;
    const cells = requiredArray(object.cells, `${rowContext}.cells`).map((cell, cellIndex) => {
      const cellContext = `${rowContext}.cells[${cellIndex}]`;
      const item = exactObject(cell, ["column", "text", "span"], cellContext);
      const column = nonnegativeInteger(item.column, `${cellContext}.column`);
      const span = positiveInteger(item.span, `${cellContext}.span`);
      if (cellIndex > 0 && column < previousEnd) {
        fail(`${cellContext}: cells must be nonoverlapping and ascending`);
      }
      previousEnd = safeSum(column, span, cellContext);
      return {
        column,
        text: requiredString(item.text, `${cellContext}.text`),
        span,
      };
    });
    return { row: rowNumber, cells };
  });
}

function parseStyleRuns(
  value: unknown,
  rows: ConformanceGridRow[],
  context: string
): ConformanceStyleRun[] {
  const rowsByIndex = new Map(rows.map((row) => [row.row, row.cells]));
  let previousRow = -1;
  let previousEnd = -1;
  let previousStyle = "";
  return requiredArray(value, context).map((run, index) => {
    const runContext = `${context}[${index}]`;
    const object = exactObject(run, [
      "row",
      "startColumn",
      "text",
      "span",
      "resolvedStyle",
    ], runContext);
    const row = nonnegativeInteger(object.row, `${runContext}.row`);
    const startColumn = nonnegativeInteger(
      object.startColumn,
      `${runContext}.startColumn`
    );
    const span = positiveInteger(object.span, `${runContext}.span`);
    const text = requiredString(object.text, `${runContext}.text`);
    const resolvedStyle = requiredObject(object.resolvedStyle, `${runContext}.resolvedStyle`);
    const styleKey = stableJSON(resolvedStyle);
    if (row < previousRow || (row === previousRow && startColumn < previousEnd)) {
      fail(`${runContext}: style runs must be ordered and nonoverlapping`);
    }
    if (row === previousRow && startColumn === previousEnd && styleKey === previousStyle) {
      fail(`${runContext}: adjacent equal-style runs must be coalesced`);
    }
    const cells = rowsByIndex.get(row);
    const first = cells?.findIndex((cell) => cell.column === startColumn) ?? -1;
    if (!cells || first < 0) {
      fail(`${runContext}: style run must begin on an explicit cell`);
    }
    let coveredSpan = 0;
    let coveredText = "";
    let nextColumn = startColumn;
    for (let cellIndex = first; coveredSpan < span && cellIndex < cells.length; cellIndex += 1) {
      const cell = cells[cellIndex]!;
      if (cell.column !== nextColumn) {
        fail(`${runContext}: style run crosses an intentional gap`);
      }
      coveredSpan = safeSum(coveredSpan, cell.span, runContext);
      nextColumn = safeSum(nextColumn, cell.span, runContext);
      coveredText += cell.text;
    }
    if (coveredSpan !== span || coveredText !== text) {
      fail(`${runContext}: style run geometry/text does not cover exact cells`);
    }
    previousRow = row;
    previousEnd = safeSum(startColumn, span, runContext);
    previousStyle = styleKey;
    return { row, startColumn, text, span, resolvedStyle };
  });
}

function validateResyncRequest(
  value: unknown,
  context: string
): void {
  const object = requiredObject(value, context);
  if (object.scope === "keyframe") {
    exactKeys(object, ["scope"], context);
    return;
  }
  if (object.scope === "images") {
    const keys = object.ids === undefined ? ["scope"] : ["scope", "ids"];
    exactKeys(object, keys, context);
    if (object.ids !== undefined) {
      const ids = stringArray(object.ids, `${context}.ids`);
      if (
        ids.length === 0
        || new Set(ids).size !== ids.length
        || ids.join("\0") !== [...ids].sort().join("\0")
      ) {
        fail(`${context}.ids: expected nonempty sorted set`);
      }
    }
    return;
  }
  fail(`${context}.scope: unknown resync scope`);
}

function validateAndroidAction(
  value: Record<string, unknown>,
  context: string
): void {
  const action = requiredString(value.action, `${context}.action`);
  switch (action) {
  case "publish": {
    exactKeys(value, ["action", "sequence", "width", "height", "rows", "damage"], context);
    nonnegativeInteger(value.sequence, `${context}.sequence`);
    const width = nonnegativeInteger(value.width, `${context}.width`);
    const height = nonnegativeInteger(value.height, `${context}.height`);
    const rows = parseGridRows(value.rows, `${context}.rows`);
    for (const row of rows) {
      if (row.row >= height || row.cells.some((cell) => safeSum(cell.column, cell.span, context) > width)) {
        fail(`${context}: published grid exceeds dimensions`);
      }
    }
    validateDamage(value.damage, height, width, `${context}.damage`);
    return;
  }
  case "sizeQuery":
    exactKeys(value, ["action", "label"], context);
    requiredNonemptyString(value.label, `${context}.label`);
    return;
  case "copy":
    exactKeys(value, ["action", "label", "capacity"], context);
    requiredNonemptyString(value.label, `${context}.label`);
    nonnegativeInteger(value.capacity, `${context}.capacity`);
    return;
  default:
    fail(`${context}.action: unknown Android action`);
  }
}

function validateDamage(
  value: unknown,
  height: number,
  width: number,
  context: string
): void {
  if (value === null) {
    return;
  }
  const object = exactObject(value, ["rows"], context);
  let previousRow = -1;
  for (const [index, row] of requiredArray(object.rows, `${context}.rows`).entries()) {
    const rowContext = `${context}.rows[${index}]`;
    const item = exactObject(row, ["row", "ranges"], rowContext);
    const rowNumber = nonnegativeInteger(item.row, `${rowContext}.row`);
    if (rowNumber <= previousRow || rowNumber >= height) {
      fail(`${rowContext}.row: invalid damage row`);
    }
    previousRow = rowNumber;
    let previousEnd = -1;
    for (const [rangeIndex, range] of requiredArray(item.ranges, `${rowContext}.ranges`).entries()) {
      const pair = requiredArray(range, `${rowContext}.ranges[${rangeIndex}]`);
      if (pair.length !== 2) {
        fail(`${rowContext}.ranges[${rangeIndex}]: expected pair`);
      }
      const start = nonnegativeInteger(pair[0], `${rowContext}.ranges[${rangeIndex}][0]`);
      const end = nonnegativeInteger(pair[1], `${rowContext}.ranges[${rangeIndex}][1]`);
      if (start >= end || end > width || start < previousEnd) {
        fail(`${rowContext}.ranges[${rangeIndex}]: invalid range`);
      }
      previousEnd = end;
    }
  }
}

function validateAndroidExpectation(
  value: Record<string, unknown>,
  context: string
): void {
  exactKeys(value, ["androidDeliveries"], context);
  for (const [index, delivery] of requiredArray(
    value.androidDeliveries,
    `${context}.androidDeliveries`
  ).entries()) {
    const deliveryContext = `${context}.androidDeliveries[${index}]`;
    const item = exactObject(delivery, [
      "label",
      "reported",
      "capacity",
      "returned",
      "copied",
      "record",
    ], deliveryContext);
    requiredNonemptyString(item.label, `${deliveryContext}.label`);
    nonnegativeInteger(item.reported, `${deliveryContext}.reported`);
    nonnegativeInteger(item.capacity, `${deliveryContext}.capacity`);
    nonnegativeInteger(item.returned, `${deliveryContext}.returned`);
    if (typeof item.copied !== "boolean") {
      fail(`${deliveryContext}.copied: expected Boolean`);
    }
    if (item.copied === false) {
      if (item.record !== null) {
        fail(`${deliveryContext}.record: uncopied delivery must be null`);
      }
      continue;
    }
    const record = exactObject(item.record, [
      "kind",
      "epoch",
      "gen",
      "baselineGen",
      "rows",
    ], `${deliveryContext}.record`);
    enumValue(record.kind, ["full", "delta"] as const, `${deliveryContext}.record.kind`);
    nullableNonnegativeInteger(record.epoch, `${deliveryContext}.record.epoch`);
    nullableNonnegativeInteger(record.gen, `${deliveryContext}.record.gen`);
    nullableNonnegativeInteger(record.baselineGen, `${deliveryContext}.record.baselineGen`);
    parseGridRows(record.rows, `${deliveryContext}.record.rows`);
  }
}

function validateChannelAction(
  value: Record<string, unknown>,
  context: string
): void {
  const action = requiredString(value.action, `${context}.action`);
  switch (action) {
  case "closeClient":
    exactKeys(value, ["action", "token"], context);
    positiveInteger(value.token, `${context}.token`);
    return;
  case "clientChunk":
    exactKeys(value, ["action", "token", "bytesBase64"], context);
    positiveInteger(value.token, `${context}.token`);
    validateBase64(
      requiredString(value.bytesBase64, `${context}.bytesBase64`),
      `${context}.bytesBase64`
    );
    return;
  case "drainInput":
    exactKeys(value, ["action"], context);
    return;
  default:
    fail(`${context}.action: unknown channel action`);
  }
}

function validateChannelExpectation(
  value: Record<string, unknown>,
  context: string
): void {
  exactKeys(value, [
    "deliveredRecords",
    "suppressedSurfaceRecords",
    "detachedNonSurfaceBacklog",
    "refreshRequestCount",
    "capsProcessedCount",
    "ignoredStaleCallbackCount",
    "acceptedClientInputs",
    "discardedInboundChunks",
    "parser",
    "connection",
  ], context);
  const observedRecords = new Map<string, string[]>();
  for (const key of ["deliveredRecords", "suppressedSurfaceRecords"] as const) {
    const records: string[] = [];
    for (const [index, record] of requiredArray(value[key], `${context}.${key}`).entries()) {
      const item = exactObject(record, [
        "raw",
        "kind",
        "epoch",
        "gen",
        "baselineGen",
      ], `${context}.${key}[${index}]`);
      const raw = requiredString(item.raw, `${context}.${key}[${index}].raw`);
      validateEmittedRecord(raw, true, `${context}.${key}[${index}].raw`);
      const kind = enumValue(
        item.kind,
        ["full", "delta", "non-surface"] as const,
        `${context}.${key}[${index}].kind`
      );
      const epoch = nullableNonnegativeInteger(
        item.epoch,
        `${context}.${key}[${index}].epoch`
      );
      const gen = nullableNonnegativeInteger(
        item.gen,
        `${context}.${key}[${index}].gen`
      );
      const baselineGen = nullableNonnegativeInteger(
        item.baselineGen,
        `${context}.${key}[${index}].baselineGen`
      );
      const derived = decodeChannelRawRecord(
        raw,
        `${context}.${key}[${index}].raw`
      );
      if (
        kind !== derived.kind
        || epoch !== derived.epoch
        || gen !== derived.gen
        || baselineGen !== derived.baselineGen
      ) {
        fail(`${context}.${key}[${index}]: metadata does not match raw record`);
      }
      if (key === "suppressedSurfaceRecords" && kind === "non-surface") {
        fail(`${context}.${key}[${index}]: suppressed record must be a surface`);
      }
      records.push(raw);
    }
    observedRecords.set(key, records);
  }
  const delivered = new Set(observedRecords.get("deliveredRecords"));
  if (
    observedRecords.get("suppressedSurfaceRecords")
      ?.some((record) => delivered.has(record))
  ) {
    fail(`${context}: one record appears as both delivered and suppressed`);
  }
  const backlog = exactObject(
    value.detachedNonSurfaceBacklog,
    ["count", "bytes"],
    `${context}.detachedNonSurfaceBacklog`
  );
  nonnegativeInteger(backlog.count, `${context}.detachedNonSurfaceBacklog.count`);
  nonnegativeInteger(backlog.bytes, `${context}.detachedNonSurfaceBacklog.bytes`);
  for (const key of [
    "refreshRequestCount",
    "capsProcessedCount",
    "ignoredStaleCallbackCount",
  ] as const) {
    nonnegativeInteger(value[key], `${context}.${key}`);
  }
  stringArray(value.acceptedClientInputs, `${context}.acceptedClientInputs`);
  for (const [index, chunk] of requiredArray(
    value.discardedInboundChunks,
    `${context}.discardedInboundChunks`
  ).entries()) {
    const item = exactObject(chunk, [
      "token",
      "bytesBase64",
      "reason",
    ], `${context}.discardedInboundChunks[${index}]`);
    positiveInteger(item.token, `${context}.discardedInboundChunks[${index}].token`);
    validateBase64(
      requiredString(
        item.bytesBase64,
        `${context}.discardedInboundChunks[${index}].bytesBase64`
      ),
      `${context}.discardedInboundChunks[${index}].bytesBase64`
    );
    enumValue(item.reason, [
      "stale-at-ingress",
      "stale-at-consumption",
      "connection-boundary",
      "terminal",
    ] as const, `${context}.discardedInboundChunks[${index}].reason`);
  }
  const parser = exactObject(value.parser, ["token", "bufferedBytes"], `${context}.parser`);
  nullablePositiveInteger(parser.token, `${context}.parser.token`);
  nonnegativeInteger(parser.bufferedBytes, `${context}.parser.bufferedBytes`);
  const connection = exactObject(value.connection, [
    "currentToken",
    "lastIssuedToken",
    "phase",
    "sceneInputFinished",
  ], `${context}.connection`);
  const currentToken = nullablePositiveInteger(
    connection.currentToken,
    `${context}.connection.currentToken`
  );
  const lastIssuedToken = positiveInteger(
    connection.lastIssuedToken,
    `${context}.connection.lastIssuedToken`
  );
  const phase = enumValue(
    connection.phase,
    ["detached", "pre-capabilities", "active"] as const,
    `${context}.connection.phase`
  );
  if (typeof connection.sceneInputFinished !== "boolean") {
    fail(`${context}.connection.sceneInputFinished: expected Boolean`);
  }
  if (connection.sceneInputFinished) {
    fail(`${context}.connection.sceneInputFinished: reconnect fixture is nonterminal`);
  }
  if (
    currentToken !== null && currentToken > lastIssuedToken
    || (phase === "detached") !== (currentToken === null)
  ) {
    fail(`${context}.connection: inconsistent token/phase state`);
  }
}

interface ChannelRawRecord {
  kind: "full" | "delta" | "non-surface";
  epoch: number | null;
  gen: number | null;
  baselineGen: number | null;
}

function decodeChannelRawRecord(
  raw: string,
  context: string
): ChannelRawRecord {
  if (!raw.startsWith("\u001Esurface:")) {
    return {
      kind: "non-surface",
      epoch: null,
      gen: null,
      baselineGen: null,
    };
  }
  const payload = requiredObject(
    JSON.parse(raw.slice("\u001Esurface:".length, -1)) as unknown,
    `${context}.surface`
  );
  if (payload.encoding !== undefined && payload.encoding !== "delta") {
    fail(`${context}.surface.encoding: expected absent or delta`);
  }
  const kind = payload.encoding === "delta" ? "delta" : "full";
  const epoch = optionalWireStamp(payload.epoch, `${context}.surface.epoch`);
  const gen = optionalWireStamp(payload.gen, `${context}.surface.gen`);
  const baselineGen = optionalWireStamp(
    payload.baselineGen,
    `${context}.surface.baselineGen`
  );
  if (kind === "full") {
    if (baselineGen !== null || (epoch === null) !== (gen === null)) {
      fail(`${context}.surface: invalid full-frame delivery stamps`);
    }
  } else if (
    (epoch === null || gen === null || baselineGen === null)
    && !(epoch === null && gen === null && baselineGen === null)
  ) {
    fail(`${context}.surface: invalid delta delivery stamps`);
  }
  return { kind, epoch, gen, baselineGen };
}

function optionalWireStamp(
  value: unknown,
  context: string
): number | null {
  return value === undefined ? null : nonnegativeInteger(value, context);
}

function validateBase64(
  value: string,
  context: string
): void {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
    || Buffer.from(value, "base64").toString("base64") !== value
  ) {
    fail(`${context}: expected canonical base64`);
  }
}

function resolveDrops(
  steps: ConformanceStep[],
  context: string
): Set<number> {
  const result = new Set<number>();
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]!;
    if (step.type !== "drop") {
      continue;
    }
    let remaining = step.count;
    for (let candidate = index - 1; candidate >= 0 && remaining > 0; candidate -= 1) {
      const preceding = steps[candidate]!;
      if (preceding.type === "drop") {
        continue;
      }
      if (preceding.type !== "emit") {
        fail(`${context}: drop at step ${index} crosses a barrier`);
      }
      if (!result.has(candidate)) {
        result.add(candidate);
        remaining -= 1;
      }
    }
    if (remaining !== 0) {
      fail(`${context}: drop at step ${index} lacks preceding unmatched emits`);
    }
  }
  return result;
}

function validateEmittedRecord(
  record: string,
  allowsNonSurface: boolean,
  context: string
): void {
  if (
    !record.startsWith("\u001E")
    || !record.endsWith("\n")
    || record.endsWith("\n\n")
    || record.includes("\r")
    || record.slice(0, -1).includes("\n")
  ) {
    fail(`${context}.emit: expected one LF-terminated RS-framed record`);
  }
  if (!allowsNonSurface && !record.startsWith("\u001Esurface:")) {
    fail(`${context}.emit: expected surface record`);
  }
  if (record.startsWith("\u001Esurface:")) {
    const payload = record.slice("\u001Esurface:".length, -1);
    const value = JSON.parse(payload) as unknown;
    requiredObject(value, `${context}.emit.surface`);
  }
}
