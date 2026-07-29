import type {
  ConformanceManifestEntry,
  ConformanceStep,
} from "./ConformanceFixtureTypes.ts";

export function validateConformanceScenarioState(
  entry: ConformanceManifestEntry,
  steps: ConformanceStep[]
): void {
  if (!steps.some((step) => step.type === "expect")) {
    fail(`${entry.file}: expected at least one expectation`);
  }
  validateDecodePlans(entry, steps);
  if (entry.kind === "android-abi") {
    validateAndroidLabels(entry, steps);
  }
  if (entry.kind === "websocket-channel") {
    validateChannelLifecycle(entry, steps);
  }
}

function validateDecodePlans(
  entry: ConformanceManifestEntry,
  steps: ConformanceStep[]
): void {
  const active = new Set<string>();
  for (const step of steps) {
    if (step.type === "decodeFailure") {
      if (active.has(step.id)) {
        fail(`${entry.file}: duplicate active decode plan for ${step.id}`);
      }
      active.add(step.id);
    } else if (step.type === "expect") {
      active.clear();
    }
  }
}

function validateAndroidLabels(
  entry: ConformanceManifestEntry,
  steps: ConformanceStep[]
): void {
  const labels = new Set<string>();
  for (const step of steps) {
    if (step.type !== "androidABI") {
      continue;
    }
    const action = step.value.action;
    const label = step.value.label;
    if (action === "sizeQuery") {
      if (typeof label !== "string" || labels.has(label)) {
        fail(`${entry.file}: duplicate or invalid size-query label`);
      }
      labels.add(label);
    } else if (action === "copy") {
      if (typeof label !== "string" || !labels.has(label)) {
        fail(`${entry.file}: copy uses missing or forward label`);
      }
    }
  }
}

function validateChannelLifecycle(
  entry: ConformanceManifestEntry,
  steps: ConformanceStep[]
): void {
  let currentToken: number | undefined = 1;
  let lastIssuedToken = 1;
  let phase: "active" | "detached" | "pre-capabilities" = "active";
  let pendingSurfaceSends: number | undefined;

  for (const step of steps) {
    if (step.type === "channel") {
      const action = step.value.action;
      const token = step.value.token;
      if (
        (action === "clientChunk" || action === "closeClient")
        && (
          typeof token !== "number"
          || token < 1
          || token > lastIssuedToken
        )
      ) {
        fail(`${entry.file}: channel action uses unknown/future token`);
      }
      if (action === "closeClient" && token === currentToken) {
        currentToken = undefined;
        phase = "detached";
        pendingSurfaceSends = undefined;
      }
      continue;
    }
    if (step.type === "reconnect") {
      if (phase !== "detached" || pendingSurfaceSends !== undefined) {
        fail(`${entry.file}: reconnect requires detached state with no pending caps`);
      }
      lastIssuedToken += 1;
      currentToken = lastIssuedToken;
      phase = "pre-capabilities";
      pendingSurfaceSends = step.capsAfter;
      if (pendingSurfaceSends === 0) {
        phase = "active";
        pendingSurfaceSends = undefined;
      }
      continue;
    }
    if (
      step.type === "emit"
      && phase === "pre-capabilities"
      && step.record.startsWith("\u001Esurface:")
      && pendingSurfaceSends !== undefined
    ) {
      pendingSurfaceSends -= 1;
      if (pendingSurfaceSends === 0) {
        phase = "active";
        pendingSurfaceSends = undefined;
      }
    }
  }
  if (pendingSurfaceSends !== undefined) {
    fail(`${entry.file}: unresolved delayed capabilities at EOF`);
  }
}

function fail(
  message: string
): never {
  throw new Error(`conformance fixture error: ${message}`);
}
