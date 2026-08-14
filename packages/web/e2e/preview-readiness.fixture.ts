import {
  BrowserWASIBridge,
  WebHostSceneRuntime,
  type WebHostSurfaceCell,
  type WebHostSurfaceFrame,
  type WebHostSurfaceImage,
} from "../dist/index.js";

interface ResizeObservation {
  columns: number;
  rows: number;
  cellWidth?: number;
  cellHeight?: number;
}

interface JourneySnapshot {
  ready: boolean;
  activeTab: "alpha" | "beta";
  counters: [number, number];
  imageOpacity: number;
  lastFrameHadImagePayload: boolean;
  imagePixel: [number, number, number, number];
  scrollOffsetY: number;
  inputRecords: string[];
  resizeRecords: ResizeObservation[];
  activeAccessibilityID?: string;
  accessibilityOrder: string[];
  focusPresentation: WebHostSceneRuntime["focusPresentation"];
  wasiEnvironment: Record<string, string>;
}

interface PreviewReadinessJourneyAPI {
  readonly ready: boolean;
  snapshot(): JourneySnapshot;
  resizeMount(width: number): void;
}

declare global {
  interface Window {
    __swiftTUIPreviewJourney: PreviewReadinessJourneyAPI;
  }
}

const recordPrefix = "\u001e";
const textDecoder = new TextDecoder();
const mount = requiredElement("journey-mount");
const inputRecords: string[] = [];
const resizeRecords: ResizeObservation[] = [];
const counters: [number, number] = [0, 0];
const imageID = "png:preview-readiness-opacity";
const imagePayload = makeImagePayload();

let activeTab: 0 | 1 = 0;
let imageOpacity = 0.25;
let scrollOffsetY = 0;
let lastFrameHadImagePayload = true;
let generation = 0;
let sequence = 0;
let ready = false;

const bridge = new BrowserWASIBridge({
  sceneId: "preview-readiness",
  columns: 40,
  rows: 14,
  renderStyle: {
    fontSize: 14,
    theme: {
      foreground: "#f8fafc",
      background: "#000000",
      tint: "#38bdf8",
    },
  },
});

bridge.subscribeResize((columns, rows, cellWidth, cellHeight) => {
  resizeRecords.push({ columns, rows, cellWidth, cellHeight });
  if (ready) {
    publishFrame();
  }
});
bridge.stdin.subscribe((chunk) => {
  for (const record of textDecoder.decode(chunk).split("\n")) {
    if (!record) {
      continue;
    }
    if (
      record.startsWith(`${recordPrefix}key:`) ||
      record.startsWith(`${recordPrefix}mouse:`)
    ) {
      inputRecords.push(record);
    }
    handleInputRecord(record);
  }
});

const runtime = new WebHostSceneRuntime({
  mount,
  descriptor: {
    id: "preview-readiness",
    title: "Browser / WASI preview-readiness",
    isDefault: true,
  },
  style: {
    fontSize: 14,
    theme: {
      foreground: "#f8fafc",
      background: "#000000",
      tint: "#38bdf8",
    },
  },
  bridge,
  onInput: (chunk) => bridge.sendInput(chunk),
  wheelMode: "chain",
});

await runtime.mount();
runtime.setVisible(true);
ready = true;
publishFrame(true);

window.__swiftTUIPreviewJourney = {
  get ready(): boolean {
    return ready;
  },
  snapshot(): JourneySnapshot {
    const activeElement = document.activeElement as HTMLElement | null;
    return {
      ready,
      activeTab: activeTab === 0 ? "alpha" : "beta",
      counters: [...counters],
      imageOpacity,
      lastFrameHadImagePayload,
      imagePixel: imagePixel(),
      scrollOffsetY,
      inputRecords: [...inputRecords],
      resizeRecords: resizeRecords.map((entry) => ({ ...entry })),
      activeAccessibilityID: activeElement?.dataset.accessibilityId,
      accessibilityOrder: Array.from(
        document.querySelectorAll<HTMLElement>("[data-accessibility-id]"),
      ).map((element) => element.dataset.accessibilityId ?? ""),
      focusPresentation: runtime.focusPresentation,
      wasiEnvironment: { ...bridge.environment },
    };
  },
  resizeMount(width): void {
    mount.style.width = `${Math.max(320, Math.round(width))}px`;
  },
};

function handleInputRecord(record: string): void {
  if (record === `${recordPrefix}key:character:x:0`) {
    counters[activeTab] += 1;
    publishFrame(false, `${tabName()} count ${counters[activeTab]}`);
    return;
  }
  if (record === `${recordPrefix}key:character:o:0`) {
    imageOpacity = 0.75;
    publishFrame(false, "Image opacity 75 percent");
    return;
  }
  if (record === `${recordPrefix}key:arrowLeft:0`) {
    activeTab = 0;
    publishFrame(false, `Selected ${tabName()} tab`);
    return;
  }
  if (record === `${recordPrefix}key:arrowRight:0`) {
    activeTab = 1;
    publishFrame(false, `Selected ${tabName()} tab`);
    return;
  }

  const pointerDown = new RegExp(
    `^${recordPrefix}mouse:down:([^:]+):([^:]+):primary:`,
  ).exec(record);
  if (pointerDown) {
    const x = Number(pointerDown[1]);
    const y = Number(pointerDown[2]);
    if (y >= 0 && y < 1 && x >= 0 && x < 8) {
      activeTab = 0;
      publishFrame(false, `Selected ${tabName()} tab`);
    } else if (y >= 0 && y < 1 && x >= 10 && x < 18) {
      activeTab = 1;
      publishFrame(false, `Selected ${tabName()} tab`);
    }
    return;
  }

  if (record.startsWith(`${recordPrefix}mouse:scrolled:`)) {
    scrollOffsetY = 34;
    publishFrame(false, "List scrolled to end");
  }
}

function publishFrame(
  includeImagePayload = false,
  announcement?: string,
): void {
  const latestResize = resizeRecords.at(-1);
  const width = Math.max(40, latestResize?.columns ?? 40);
  const height = Math.max(14, latestResize?.rows ?? 14);
  const rows: WebHostSurfaceCell[][] = Array.from({ length: height }, () => []);
  rows[0] = row(activeTab === 0 ? "[Alpha]   Beta" : " Alpha   [Beta]", 1);
  rows[2] = row(`${tabName()} counter: ${counters[activeTab]}`);
  rows[3] = row("Press x to increase; o raises image opacity");
  rows[9] = row(`Scrollable list offset: ${scrollOffsetY}`);

  const image: WebHostSurfaceImage = {
    id: imageID,
    format: "png",
    bounds: [24, 4, 6, 4],
    visibleBounds: [24, 4, 6, 4],
    scalingMode: "stretch",
    opacity: imageOpacity,
    pixelSize: [2, 2],
    ...(includeImagePayload ? { dataBase64: imagePayload } : {}),
  };
  lastFrameHadImagePayload = includeImagePayload;

  const activePanelID =
    activeTab === 0 ? "root/panel-alpha" : "root/panel-beta";
  const inactivePanelID =
    activeTab === 0 ? "root/panel-beta" : "root/panel-alpha";
  const frame: WebHostSurfaceFrame = {
    version: 2,
    epoch: 1,
    gen: generation,
    sequence,
    width,
    height,
    styles: [null, { fg: "#ffffff", bg: "#1d4ed8", em: 1 }],
    rows,
    images: [image],
    accessibilityTree: [
      {
        id: "root",
        rect: [0, 0, width, height],
        role: "group",
        label: "Preview readiness journey",
      },
      {
        id: "root/tabs",
        parentId: "root",
        rect: [0, 0, 18, 1],
        role: "tabView",
        label: "Counter tabs",
      },
      {
        id: "root/tabs/alpha",
        parentId: "root/tabs",
        rect: [0, 0, 8, 1],
        role: "tab",
        label: activeTab === 0 ? "Alpha tab, selected" : "Alpha tab",
      },
      {
        id: "root/tabs/beta",
        parentId: "root/tabs",
        rect: [10, 0, 8, 1],
        role: "tab",
        label: activeTab === 1 ? "Beta tab, selected" : "Beta tab",
      },
      {
        id: activePanelID,
        parentId: "root",
        rect: [0, 2, 22, 3],
        role: "tabPanel",
        label: `${tabName()} panel`,
      },
      {
        id: "root/editor",
        parentId: activePanelID,
        rect: [0, 3, 20, 1],
        role: "textField",
        label: `${tabName()} editor`,
        cursorAnchor: [Math.min(19, 11 + counters[activeTab]), 3],
        isFocused: true,
      },
      {
        id: "root/status",
        parentId: activePanelID,
        rect: [0, 2, 20, 1],
        role: "status",
        label: `${tabName()} count ${counters[activeTab]}`,
        liveRegion: "polite",
      },
      {
        id: "root/image",
        parentId: "root",
        rect: [24, 4, 6, 4],
        role: "image",
        label: `Opacity sample ${Math.round(imageOpacity * 100)} percent`,
      },
      {
        id: inactivePanelID,
        parentId: "root",
        rect: [0, 2, 22, 3],
        role: "tabPanel",
        label: "Inactive tab content",
        hidden: true,
      },
    ],
    accessibilityAnnouncements: announcement
      ? [{ message: announcement, politeness: "polite" }]
      : [],
    scrollRegions: [
      {
        id: "root/list",
        rect: [0, 8, 20, 3],
        offset: [0, scrollOffsetY],
        content: [20, 37],
      },
    ],
    focusPresentation: {
      focusedIdentity: "root/editor",
      semantics: "edit",
      prefersTextInput: true,
      hasFocusedRegion: true,
    },
  };
  generation += 1;
  sequence += 1;
  bridge.stdout.write(`${recordPrefix}surface:${JSON.stringify(frame)}\n`);
}

function row(text: string, styleIndex = 0): WebHostSurfaceCell[] {
  return [[0, text, Array.from(text).length, styleIndex]];
}

function tabName(): "Alpha" | "Beta" {
  return activeTab === 0 ? "Alpha" : "Beta";
}

function imagePixel(): [number, number, number, number] {
  const canvas = runtime.terminalMount.querySelector("canvas");
  const context = canvas?.getContext("2d", { willReadFrequently: true });
  const latestResize = resizeRecords.at(-1);
  const cellWidth = latestResize?.cellWidth;
  const cellHeight = latestResize?.cellHeight;
  if (!canvas || !context || !cellWidth || !cellHeight) {
    return [0, 0, 0, 0];
  }
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const x = Math.max(0, Math.floor(27 * cellWidth * scaleX));
  const y = Math.max(0, Math.floor(6 * cellHeight * scaleY));
  const pixel = context.getImageData(x, y, 1, 1).data;
  return [pixel[0] ?? 0, pixel[1] ?? 0, pixel[2] ?? 0, pixel[3] ?? 0];
}

function makeImagePayload(): string {
  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = 2;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("The browser journey requires a 2D canvas context.");
  }
  context.fillStyle = "#ff0000";
  context.fillRect(0, 0, 2, 2);
  return canvas.toDataURL("image/png").split(",")[1] ?? "";
}

function requiredElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing browser journey element #${id}.`);
  }
  return element;
}
