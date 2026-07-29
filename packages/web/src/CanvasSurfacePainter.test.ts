import { expect, test } from "bun:test";

import {
  CanvasSurfacePainter,
  MAX_IMAGE_DECODE_ATTEMPTS,
  MAX_UNRESOLVED_IMAGE_CACHE_ENTRIES,
} from "./CanvasSurfacePainter.ts";
import type { SurfaceMetrics } from "./SurfaceRenderer.ts";
import { normalizeWebHostTerminalStyle } from "./WebHostTerminalStyle.ts";
import {
  MAX_IMAGE_RECOVERY_ID_BYTES,
  type WebHostSurfaceFrame,
  type WebHostSurfaceImage,
} from "./WebHostSurfaceTransport.ts";

test("transient image decode failures retry on later paints up to three total attempts", async () => {
  const context = new RecordingCanvasContext();
  const misses: string[][] = [];
  let attempts = 0;
  let redraws = 0;
  const decodedImage = { decoded: true } as unknown as CanvasImageSource;
  const painter = new CanvasSurfacePainter({
    decodeImage: async () => {
      attempts += 1;
      if (attempts < MAX_IMAGE_DECODE_ATTEMPTS) {
        throw new Error("transient decode failure");
      }
      return decodedImage;
    },
    onImagePayloadMiss: (ids) => misses.push([...ids]),
  });
  painter.attach(fakeCanvas(context), () => {
    redraws += 1;
  });
  const frame = imageFrame(image({ dataBase64: "QUJD" }));

  painter.paint(metrics, frame);
  await flushPromises();
  painter.paint(metrics, frame);
  await flushPromises();
  painter.paint(metrics, frame);
  await flushPromises();
  painter.paint(metrics, imageFrame(image()));

  expect(MAX_IMAGE_DECODE_ATTEMPTS).toBe(3);
  expect(attempts).toBe(3);
  expect(redraws).toBe(3);
  expect(misses).toEqual([]);
  expect(context.drawnImages).toEqual([decodedImage]);
});

test("permanent image decode failure requests exactly that image after three total attempts", async () => {
  const context = new RecordingCanvasContext();
  const misses: string[][] = [];
  let attempts = 0;
  const painter = new CanvasSurfacePainter({
    decodeImage: async () => {
      attempts += 1;
      throw new Error("permanent decode failure");
    },
    onImagePayloadMiss: (ids) => misses.push([...ids]),
  });
  painter.attach(fakeCanvas(context), () => {});
  const frame = imageFrame(image({ id: "png:broken", dataBase64: "%%%%" }));

  for (let attempt = 0; attempt < MAX_IMAGE_DECODE_ATTEMPTS; attempt += 1) {
    painter.paint(metrics, frame);
    await flushPromises();
  }
  painter.paint(metrics, frame);
  painter.paint(metrics, frame);
  await flushPromises();

  expect(attempts).toBe(3);
  expect(misses).toEqual([["png:broken"]]);
  expect(context.drawnImages).toEqual([]);
});

test("simultaneous exhausted Canvas images coalesce into one deterministic request", async () => {
  const misses: string[][] = [];
  const painter = new CanvasSurfacePainter({
    decodeImage: async () => {
      throw new Error("permanent decode failure");
    },
    onImagePayloadMiss: (ids) => misses.push([...ids]),
  });
  painter.attach(fakeCanvas(new RecordingCanvasContext()), () => {});
  const frame = imageFrame(
    image({ id: "png:z", dataBase64: "Wg==" }),
    image({ id: "png:a", dataBase64: "QQ==" }),
  );

  for (let attempt = 0; attempt < MAX_IMAGE_DECODE_ATTEMPTS; attempt += 1) {
    painter.paint(metrics, frame);
    await flushPromises();
  }

  expect(misses).toEqual([["png:a", "png:z"]]);
});

test("equivalent payloads across distinct frames share one three-attempt budget", async () => {
  const misses: string[][] = [];
  let attempts = 0;
  const painter = new CanvasSurfacePainter({
    decodeImage: async () => {
      attempts += 1;
      throw new Error("permanent decode failure");
    },
    onImagePayloadMiss: (ids) => misses.push([...ids]),
  });
  painter.attach(fakeCanvas(new RecordingCanvasContext()), () => {});

  for (let frameIndex = 0; frameIndex < 5; frameIndex += 1) {
    painter.paint(metrics, imageFrame(image({
      id: "png:stable",
      dataBase64: "QUJD",
    })));
    await flushPromises();
  }

  expect(attempts).toBe(3);
  expect(misses).toEqual([["png:stable"]]);
});

test("an empty-damage recovery frame applies one acknowledged payload generation", async () => {
  const context = new RecordingCanvasContext();
  const misses: string[][] = [];
  let attempts = 0;
  const decodedImage = { recovered: true } as unknown as CanvasImageSource;
  const painter = new CanvasSurfacePainter({
    decodeImage: async () => {
      attempts += 1;
      if (attempts <= MAX_IMAGE_DECODE_ATTEMPTS) {
        throw new Error("decode failed before resync");
      }
      return decodedImage;
    },
    onImagePayloadMiss: (ids) => misses.push([...ids]),
  });
  painter.attach(fakeCanvas(context), () => {});
  const initial = imageFrame(image({ id: "png:recover", dataBase64: "QUJD" }));

  for (let attempt = 0; attempt < MAX_IMAGE_DECODE_ATTEMPTS; attempt += 1) {
    painter.paint(metrics, initial);
    await flushPromises();
  }
  expect(misses).toEqual([["png:recover"]]);

  const resynced = imageFrame(image({ id: "png:recover", dataBase64: "QUJD" }));
  resynced.damage = {
    textRows: [],
    requiresFullTextRepaint: false,
    requiresFullGraphicsReplay: false,
  };
  painter.paint(
    metrics,
    resynced,
    resynced.damage,
    ["png:recover"]
  );
  await flushPromises();
  painter.paint(metrics, imageFrame(image({ id: "png:recover" })));

  expect(attempts).toBe(4);
  expect(misses).toEqual([["png:recover"]]);
  expect(context.drawnImages).toEqual([decodedImage]);
});

test("one identical recovery response opens only one new bounded retry generation", async () => {
  const misses: string[][] = [];
  let attempts = 0;
  const painter = new CanvasSurfacePainter({
    decodeImage: async () => {
      attempts += 1;
      throw new Error("permanent decode failure");
    },
    onImagePayloadMiss: (ids) => misses.push([...ids]),
  });
  painter.attach(fakeCanvas(new RecordingCanvasContext()), () => {});
  const frame = imageFrame(image({
    id: "png:bounded-recovery",
    dataBase64: "QUJD",
  }));

  for (let attempt = 0; attempt < 5; attempt += 1) {
    painter.paint(metrics, frame);
    await flushPromises();
  }
  painter.paint(metrics, frame, undefined, ["png:bounded-recovery"]);
  await flushPromises();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    painter.paint(metrics, frame);
    await flushPromises();
  }

  expect(attempts).toBe(2 * MAX_IMAGE_DECODE_ATTEMPTS);
  expect(misses).toEqual([
    ["png:bounded-recovery"],
    ["png:bounded-recovery"],
  ]);
});

test("payload-less visible Canvas misses report immediately and reset with the wire epoch", () => {
  const misses: string[][] = [];
  const painter = new CanvasSurfacePainter({
    decodeImage: async () => ({}) as CanvasImageSource,
    onImagePayloadMiss: (ids) => misses.push([...ids]),
  });
  painter.attach(fakeCanvas(new RecordingCanvasContext()), () => {});

  const firstEpoch = imageFrame(
    image({ id: "png:z" }),
    image({ id: "png:a" })
  );
  firstEpoch.epoch = 7;
  painter.paint(metrics, firstEpoch);
  painter.paint(metrics, firstEpoch);

  const nextEpoch = imageFrame(image({ id: "png:a" }));
  nextEpoch.epoch = 8;
  painter.paint(metrics, nextEpoch);

  expect(misses).toEqual([
    ["png:a", "png:z"],
    ["png:a"],
  ]);
});

test("Canvas retries image payload IDs rejected by partial admission", () => {
  const admissionAttempts: Array<{
    candidates: string[];
    accepted: string[];
  }> = [];
  const painter = new CanvasSurfacePainter({
    onImagePayloadMiss: (ids) => {
      const accepted = admissionAttempts.length === 0
        ? ids.filter((id) => id === "png:a")
        : [...ids];
      admissionAttempts.push({
        candidates: [...ids],
        accepted: [...accepted],
      });
      return accepted;
    },
  });
  painter.attach(fakeCanvas(new RecordingCanvasContext()), () => {});
  const frame = imageFrame(
    image({ id: "png:b" }),
    image({ id: "png:a" })
  );

  painter.paint(metrics, frame);
  painter.paint(metrics, frame);
  painter.paint(metrics, frame);

  expect(admissionAttempts).toEqual([
    {
      candidates: ["png:a", "png:b"],
      accepted: ["png:a"],
    },
    {
      candidates: ["png:b"],
      accepted: ["png:b"],
    },
  ]);
});

test("Canvas ignores missing payloads for unsupported or non-positive-area images", () => {
  const misses: string[][] = [];
  let attempts = 0;
  const painter = new CanvasSurfacePainter({
    decodeImage: async () => {
      attempts += 1;
      return {} as CanvasImageSource;
    },
    onImagePayloadMiss: (ids) => misses.push([...ids]),
  });
  painter.attach(fakeCanvas(new RecordingCanvasContext()), () => {});

  painter.paint(metrics, imageFrame(
    image({ id: "future", format: "future-format" }),
    image({ id: "zero-bounds", bounds: [0, 0, 0, 1] }),
    image({ id: "invisible", visibleBounds: [0, 0, 1, 0] }),
  ));

  expect(attempts).toBe(0);
  expect(misses).toEqual([]);
});

test("Canvas renders supplied payloads whose image ids exceed the recovery limit", async () => {
  const context = new RecordingCanvasContext();
  const misses: string[][] = [];
  const decodedImage = { decoded: true } as unknown as CanvasImageSource;
  let attempts = 0;
  const painter = new CanvasSurfacePainter({
    decodeImage: async () => {
      attempts += 1;
      return decodedImage;
    },
    onImagePayloadMiss: (ids) => misses.push([...ids]),
  });
  painter.attach(fakeCanvas(context), () => {});
  const longId = `png:${"x".repeat(MAX_IMAGE_RECOVERY_ID_BYTES + 1)}`;

  painter.paint(metrics, imageFrame(image({
    id: longId,
    dataBase64: "QUJD",
  })));
  await flushPromises();
  painter.paint(metrics, imageFrame(image({ id: longId })));

  expect(attempts).toBe(1);
  expect(context.drawnImages).toEqual([decodedImage]);
  expect(misses).toEqual([]);
});

test("Canvas retains a pending long-id decode across a payload-less repeat", async () => {
  const context = new RecordingCanvasContext();
  const misses: string[][] = [];
  const decodedImage = { decoded: true } as unknown as CanvasImageSource;
  let resolveDecode: ((image: CanvasImageSource) => void) | undefined;
  const decode = new Promise<CanvasImageSource>((resolve) => {
    resolveDecode = resolve;
  });
  const painter = new CanvasSurfacePainter({
    decodeImage: () => decode,
    onImagePayloadMiss: (ids) => misses.push([...ids]),
  });
  painter.attach(fakeCanvas(context), () => {});
  const longId = `png:${"x".repeat(MAX_IMAGE_RECOVERY_ID_BYTES + 1)}`;

  painter.paint(metrics, imageFrame(image({
    id: longId,
    dataBase64: "QUJD",
  })));
  painter.paint(metrics, imageFrame(image({ id: longId })));
  resolveDecode?.(decodedImage);
  await flushPromises();
  painter.paint(metrics, imageFrame(image({ id: longId })));

  expect(context.drawnImages).toEqual([decodedImage]);
  expect(misses).toEqual([]);
});

test("Canvas bounds unresolved entries and sweeps disappeared image ids", () => {
  const misses: string[][] = [];
  const painter = new CanvasSurfacePainter({
    onImagePayloadMiss: (ids) => misses.push([...ids]),
  });
  painter.attach(fakeCanvas(new RecordingCanvasContext()), () => {});
  const images = Array.from(
    { length: MAX_UNRESOLVED_IMAGE_CACHE_ENTRIES + 1 },
    (_, index) => image({ id: `png:${String(index).padStart(4, "0")}` })
  );
  const overflow = images.at(-1)!;

  painter.paint(metrics, imageFrame(...images));
  expect(misses).toHaveLength(1);
  expect(misses[0]).toHaveLength(MAX_UNRESOLVED_IMAGE_CACHE_ENTRIES);
  expect(misses[0]).not.toContain(overflow.id);

  painter.paint(metrics, imageFrame(overflow));
  expect(misses.at(-1)).toEqual([overflow.id]);
});

test("Canvas unresolved sweeping preserves successfully decoded image cache entries", async () => {
  const decodedImage = { decoded: true } as unknown as CanvasImageSource;
  let attempts = 0;
  const context = new RecordingCanvasContext();
  const painter = new CanvasSurfacePainter({
    decodeImage: async () => {
      attempts += 1;
      return decodedImage;
    },
  });
  painter.attach(fakeCanvas(context), () => {});

  painter.paint(metrics, imageFrame(image({
    id: "png:successful",
    dataBase64: "QUJD",
  })));
  await flushPromises();
  painter.paint(metrics, imageFrame());
  painter.paint(metrics, imageFrame(image({ id: "png:successful" })));

  expect(attempts).toBe(1);
  expect(context.drawnImages).toEqual([decodedImage]);
});

const metrics: SurfaceMetrics = {
  columns: 4,
  rows: 2,
  cellWidth: 8,
  cellHeight: 18,
  style: normalizeWebHostTerminalStyle({}),
};

function image(
  overrides: Partial<WebHostSurfaceImage> = {}
): WebHostSurfaceImage {
  return {
    id: "png:test",
    format: "png",
    bounds: [0, 0, 1, 1],
    visibleBounds: [0, 0, 1, 1],
    scalingMode: "stretch",
    ...overrides,
  };
}

function imageFrame(
  ...images: WebHostSurfaceImage[]
): WebHostSurfaceFrame {
  return {
    version: 2,
    width: 4,
    height: 2,
    styles: [null],
    rows: [[], []],
    images,
  };
}

function fakeCanvas(
  context: RecordingCanvasContext
): HTMLCanvasElement {
  return {
    width: 32,
    height: 36,
    getContext: (kind: string) => kind === "2d" ? context : null,
  } as unknown as HTMLCanvasElement;
}

class RecordingCanvasContext {
  fillStyle: string | CanvasGradient | CanvasPattern = "";
  strokeStyle: string | CanvasGradient | CanvasPattern = "";
  font = "";
  textBaseline: CanvasTextBaseline = "alphabetic";
  globalAlpha = 1;
  readonly drawnImages: CanvasImageSource[] = [];

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
  setLineDash(): void {}

  drawImage(
    image: CanvasImageSource
  ): void {
    this.drawnImages.push(image);
  }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
