import {
  CanvasSurfacePainter,
} from "./CanvasSurfacePainter.ts";
import {
  DomSurfacePainter,
} from "./DomSurfacePainter.ts";
import {
  canvasSurfacePainterConformanceControl,
  domSurfacePainterConformanceControl,
} from "./SurfacePainterConformanceControl.ts";
import type { SurfaceMetrics } from "./SurfaceRenderer.ts";
import { normalizeWebHostTerminalStyle } from "./WebHostTerminalStyle.ts";
import {
  WebHostOutputDecoder,
  type WebHostResyncRequest,
  type WebHostSurfaceFrame,
  type WebHostSurfaceStyle,
} from "./WebHostSurfaceTransport.ts";
import type {
  ConformanceExpectation,
  ConformanceFixture,
  ConformanceGridRow,
  ConformanceStyleRun,
  WebConformanceRunner,
} from "./ConformanceFixtureLoader.ts";

export interface WebConformanceObservation {
  rows: ConformanceGridRow[];
  imagesVisible: string[];
  resyncRequests: unknown[];
  styleRuns?: ConformanceStyleRun[];
}

export interface WebConformanceRunResult {
  scenario: string;
  runner: WebConformanceRunner;
  expectations: WebConformanceObservation[];
}

export async function runWebConformanceFixture(
  fixture: ConformanceFixture,
  runner: WebConformanceRunner
): Promise<WebConformanceRunResult> {
  if (!fixture.entry.runners.includes(runner)) {
    throw new Error(`${fixture.entry.scenario}: runner ${runner} is not applicable`);
  }
  const environment = new WebSurfaceConformanceEnvironment(runner);
  const observations: WebConformanceObservation[] = [];
  try {
    for (let index = 0; index < fixture.steps.length; index += 1) {
      const step = fixture.steps[index]!;
      switch (step.type) {
      case "emit":
        if (!fixture.droppedEmitIndexes.has(index)) {
          environment.emit(step.record);
          await environment.drainToQuiescence();
        }
        break;
      case "drop":
        break;
      case "evictImages":
        environment.evictImages(step.ids);
        await environment.drainToQuiescence();
        break;
      case "reconnect":
        if (step.capsAfter !== undefined) {
          throw new Error(`${fixture.entry.scenario}: web runner cannot execute capsAfter`);
        }
        environment.reconnect();
        await environment.drainToQuiescence();
        break;
      case "decodeFailure":
        if (runner !== "web-canvas") {
          throw new Error(`${fixture.entry.scenario}: decodeFailure requires web-canvas`);
        }
        environment.addDecodePlan(step.id, step.outcomes);
        await environment.drainToQuiescence();
        break;
      case "expect": {
        const expected = step.expectation;
        if (!expected) {
          throw new Error(`${fixture.entry.scenario}: missing web expectation`);
        }
        environment.assertDecodePlansConsumed("expect");
        const observation = environment.observe(expected.styleRuns !== undefined);
        assertWebConformanceObservation(expected, observation);
        observations.push(observation);
        environment.consumeResyncRequests();
        break;
      }
      case "androidABI":
      case "channel":
        throw new Error(
          `${fixture.entry.scenario}: ${step.type} is not executable by ${runner}`
        );
      }
    }
    environment.assertDecodePlansConsumed("EOF");
    return { scenario: fixture.entry.scenario, runner, expectations: observations };
  } finally {
    environment.dispose();
  }
}

export function assertWebConformanceObservation(
  expected: ConformanceExpectation,
  actual: WebConformanceObservation
): void {
  const expectedValue: WebConformanceObservation = {
    rows: expected.rows,
    imagesVisible: expected.imagesVisible,
    resyncRequests: expected.resyncRequests,
    ...(expected.styleRuns === undefined ? {} : { styleRuns: expected.styleRuns }),
  };
  if (stableJSON(expectedValue) !== stableJSON(actual)) {
    throw new Error(
      "web conformance observation mismatch\n"
      + `expected: ${stableJSON(expectedValue)}\n`
      + `actual:   ${stableJSON(actual)}`
    );
  }
}

interface DecodePlan {
  outcomes: Array<"failure" | "success">;
  nextIndex: number;
}

class WebSurfaceConformanceEnvironment {
  private decoder = new WebHostOutputDecoder();
  private canvasPainter?: CanvasSurfacePainter;
  private domPainter?: DomSurfacePainter;
  private currentFrame?: WebHostSurfaceFrame;
  private readonly decodePlans = new Map<string, DecodePlan>();
  private readonly resyncRequests: WebHostResyncRequest[] = [];
  private redrawRequested = false;
  private fixtureFailure?: Error;
  private fakeDOM?: FakeDOMInstallation;

  constructor(
    private readonly runner: WebConformanceRunner
  ) {
    this.makePainter();
  }

  emit(
    record: string
  ): void {
    const decoded = this.decoder.feed(new TextEncoder().encode(record));
    for (const output of decoded) {
      if (output.type === "surface") {
        this.currentFrame = output.frame;
        this.presentCurrentFrame();
      }
    }
    this.collectResyncRequests();
  }

  evictImages(
    ids: readonly string[]
  ): void {
    if (this.canvasPainter) {
      canvasSurfacePainterConformanceControl(this.canvasPainter).evictImages(ids);
    } else {
      if (this.domPainter) {
        domSurfacePainterConformanceControl(this.domPainter).evictImages(ids);
      }
    }
  }

  reconnect(): void {
    this.decoder = new WebHostOutputDecoder();
    this.currentFrame = undefined;
    this.redrawRequested = false;
    this.makePainter();
  }

  addDecodePlan(
    id: string,
    outcomes: Array<"failure" | "success">
  ): void {
    if (this.decodePlans.has(id)) {
      throw new Error(`duplicate active decode plan for ${id}`);
    }
    this.decodePlans.set(id, { outcomes: [...outcomes], nextIndex: 0 });
  }

  assertDecodePlansConsumed(
    context: string
  ): void {
    this.assertHealthy();
    for (const [id, plan] of this.decodePlans) {
      if (plan.nextIndex !== plan.outcomes.length) {
        throw new Error(
          `${context}: decode plan for ${id} has `
          + `${plan.outcomes.length - plan.nextIndex} unconsumed outcomes`
        );
      }
    }
    this.decodePlans.clear();
  }

  async drainToQuiescence(): Promise<void> {
    let previous = stableJSON(this.observe(false));
    let stableTurns = 0;
    for (let turn = 1; turn <= 32; turn += 1) {
      await Promise.resolve();
      this.assertHealthy();
      if (this.redrawRequested) {
        this.redrawRequested = false;
        this.presentCurrentFrame();
      }
      this.collectResyncRequests();
      this.assertHealthy();
      const next = stableJSON(this.observe(false));
      if (next === previous) {
        stableTurns += 1;
        if (stableTurns === 2) {
          return;
        }
      } else {
        stableTurns = 0;
        previous = next;
      }
    }
    throw new Error("web conformance runner did not quiesce within 32 turns");
  }

  observe(
    includesStyleRuns: boolean
  ): WebConformanceObservation {
    const frame = this.currentFrame;
    const images = frame?.images ?? [];
    const imagesVisible = this.canvasPainter
      ? canvasSurfacePainterConformanceControl(this.canvasPainter)
        .visibleImageIDs(images)
      : this.domPainter
        ? domSurfacePainterConformanceControl(this.domPainter).visibleImageIDs()
        : [];
    return {
      rows: structuredRows(frame),
      imagesVisible,
      resyncRequests: structuredClone(this.resyncRequests),
      ...(includesStyleRuns ? { styleRuns: styleRuns(frame) } : {}),
    };
  }

  consumeResyncRequests(): void {
    this.resyncRequests.length = 0;
  }

  dispose(): void {
    this.fakeDOM?.restore();
    this.fakeDOM = undefined;
  }

  private makePainter(): void {
    this.fakeDOM?.restore();
    this.fakeDOM = undefined;
    if (this.runner === "web-canvas") {
      const painter = new CanvasSurfacePainter({
        decodeImage: async (_payload, _format, imageID) => {
          const plan = this.decodePlans.get(imageID);
          if (!plan) {
            return { imageID } as unknown as CanvasImageSource;
          }
          const outcome = plan.outcomes[plan.nextIndex];
          if (outcome === undefined) {
            this.fixtureFailure = new Error(
              `unexpected decode attempt after plan exhaustion for ${imageID}`
            );
            throw this.fixtureFailure;
          }
          plan.nextIndex += 1;
          if (outcome === "failure") {
            throw new Error(`planned decode failure for ${imageID}`);
          }
          return { imageID } as unknown as CanvasImageSource;
        },
        onImagePayloadMiss: (ids) => this.decoder.requestImagePayloads(ids),
      });
      painter.attach(
        fakeCanvas(new ConformanceCanvasContext()),
        () => {
          this.redrawRequested = true;
        }
      );
      this.canvasPainter = painter;
      this.domPainter = undefined;
      return;
    }

    this.fakeDOM = installFakeDOM();
    const painter = new DomSurfacePainter({
      onImagePayloadMiss: (ids) => this.decoder.requestImagePayloads(ids),
    });
    painter.attach(new FakeElement("div") as unknown as HTMLElement);
    this.domPainter = painter;
    this.canvasPainter = undefined;
  }

  private presentCurrentFrame(): void {
    const frame = this.currentFrame;
    if (!frame) {
      return;
    }
    const recoveredImagePayloadIDs = this.decoder.prepareToPresentSurface(frame);
    const metrics: SurfaceMetrics = {
      columns: frame.width,
      rows: frame.height,
      cellWidth: 8,
      cellHeight: 18,
      style: normalizeWebHostTerminalStyle({}),
    };
    if (this.canvasPainter) {
      this.canvasPainter.paint(metrics, frame, frame.damage, recoveredImagePayloadIDs);
    } else {
      this.domPainter?.paint(metrics, frame, frame.damage, recoveredImagePayloadIDs);
    }
  }

  private collectResyncRequests(): void {
    while (true) {
      const request = this.decoder.takeResyncRequest();
      if (!request) {
        return;
      }
      this.resyncRequests.push(structuredClone(request));
    }
  }

  private assertHealthy(): void {
    if (this.fixtureFailure) {
      throw this.fixtureFailure;
    }
  }
}

function structuredRows(
  frame: WebHostSurfaceFrame | undefined
): ConformanceGridRow[] {
  if (!frame) {
    return [];
  }
  const rows: ConformanceGridRow[] = [];
  for (let row = 0; row < frame.rows.length; row += 1) {
    const cells = frame.rows[row] ?? [];
    if (cells.length === 0) {
      continue;
    }
    rows.push({
      row,
      cells: cells.map(([column, text, span]) => ({ column, text, span })),
    });
  }
  return rows;
}

function styleRuns(
  frame: WebHostSurfaceFrame | undefined
): ConformanceStyleRun[] {
  if (!frame) {
    return [];
  }
  const runs: ConformanceStyleRun[] = [];
  for (let row = 0; row < frame.rows.length; row += 1) {
    for (const [column, text, span, styleIndex] of frame.rows[row] ?? []) {
      const resolvedStyle = frame.styles[styleIndex];
      if (!resolvedStyle) {
        continue;
      }
      const prior = runs.at(-1);
      if (
        prior
        && prior.row === row
        && prior.startColumn + prior.span === column
        && stableJSON(prior.resolvedStyle) === stableJSON(resolvedStyle)
      ) {
        prior.text += text;
        prior.span += span;
        continue;
      }
      runs.push({
        row,
        startColumn: column,
        text,
        span,
        resolvedStyle: canonicalStyle(resolvedStyle),
      });
    }
  }
  return runs;
}

function canonicalStyle(
  style: WebHostSurfaceStyle
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(style)
      .filter(([, value]) => value !== undefined)
      .sort(([lhs], [rhs]) => lhs.localeCompare(rhs))
  );
}

function stableJSON(
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

function fakeCanvas(
  context: ConformanceCanvasContext
): HTMLCanvasElement {
  return {
    width: 8_192,
    height: 8_192,
    getContext: (kind: string) => kind === "2d" ? context : null,
  } as unknown as HTMLCanvasElement;
}

class ConformanceCanvasContext {
  fillStyle: string | CanvasGradient | CanvasPattern = "";
  strokeStyle: string | CanvasGradient | CanvasPattern = "";
  font = "";
  textBaseline: CanvasTextBaseline = "alphabetic";
  globalAlpha = 1;
  lineWidth = 1;

  setTransform(): void {}
  clearRect(): void {}
  fillRect(): void {}
  fillText(): void {}
  save(): void {}
  beginPath(): void {}
  rect(): void {}
  clip(): void {}
  restore(): void {}
  stroke(): void {}
  moveTo(): void {}
  lineTo(): void {}
  quadraticCurveTo(): void {}
  setLineDash(): void {}
  drawImage(): void {}
}

interface FakeDOMInstallation {
  restore(): void;
}

function installFakeDOM(): FakeDOMInstallation {
  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement: (tagName: string) => tagName === "canvas"
      ? new FakeCanvasElement()
      : new FakeElement(tagName),
  } as unknown as Document;
  return {
    restore: () => {
      globalThis.document = previousDocument;
    },
  };
}

class FakeStyle {
  [key: string]: unknown;
}

class FakeElement {
  readonly style = new FakeStyle() as unknown as CSSStyleDeclaration;
  children: FakeElement[] = [];
  parent?: FakeElement;
  className = "";
  textContent = "";
  private readonly attributes = new Map<string, string>();

  constructor(
    readonly tagName: string
  ) {}

  appendChild(
    child: FakeElement
  ): FakeElement {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  replaceChildren(
    ...children: FakeElement[]
  ): void {
    for (const child of children) {
      child.parent = this;
    }
    this.children.splice(0, this.children.length, ...children);
  }

  remove(): void {
    const siblings = this.parent?.children;
    if (!siblings) {
      return;
    }
    const index = siblings.indexOf(this);
    if (index >= 0) {
      siblings.splice(index, 1);
    }
  }

  setAttribute(
    name: string,
    value: string
  ): void {
    this.attributes.set(name, value);
  }

  getAttribute(
    name: string
  ): string | null {
    return this.attributes.get(name) ?? null;
  }
}

class FakeCanvasElement extends FakeElement {
  constructor() {
    super("canvas");
  }

  getContext(
    contextID: string
  ): { font: string; measureText(text: string): { width: number } } | undefined {
    if (contextID !== "2d") {
      return undefined;
    }
    return {
      font: "",
      measureText: (text) => ({
        width: Math.max(1, Array.from(text).length) * 8,
      }),
    };
  }
}
