import { expect, test } from "bun:test";
import { CanvasSurfacePainter } from "./CanvasSurfacePainter.ts";
import {
  MAX_IMAGE_RECOVERY_ID_BYTES,
  type WebHostSurfaceFrame,
  type WebHostSurfaceImage,
} from "./WebHostSurfaceTransport.ts";
import { normalizeWebHostTerminalStyle } from "./WebHostTerminalStyle.ts";

const metrics = {
  columns: 2,
  rows: 1,
  cellWidth: 1,
  cellHeight: 1,
  style: normalizeWebHostTerminalStyle({}),
};
const image = (id: string, payload = true): WebHostSurfaceImage => ({
  id,
  format: "png",
  bounds: [0, 0, 1, 1],
  visibleBounds: [0, 0, 1, 1],
  scalingMode: "stretch",
  ...(payload ? { dataBase64: "QQ==" } : {}),
});
const frame = (...images: WebHostSurfaceImage[]): WebHostSurfaceFrame => ({
  version: 2,
  width: 2,
  height: 1,
  styles: [null],
  rows: [[]],
  images,
});
const context = new Proxy({}, { get: () => () => {} });
const canvas = {
  width: 2,
  height: 1,
  getContext: () => context,
} as unknown as HTMLCanvasElement;
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

function decoded(id: string, closed: string[], width = 1): CanvasImageSource {
  return {
    width,
    height: 1,
    close: () => closed.push(id),
  } as unknown as CanvasImageSource;
}

test("decoded image LRU obeys byte budget and evicted transmit-once images recover", async () => {
  const closed: string[] = [];
  const misses: string[][] = [];
  let decodes = 0;
  const painter = new CanvasSurfacePainter({
    maxDecodedImageCacheBytes: 8,
    decodeImage: async (_payload, _format, id) => {
      decodes++;
      return decoded(id, closed);
    },
    onImagePayloadMiss: (ids) => {
      misses.push([...ids]);
    },
  });
  painter.attach(canvas, () => {});
  for (const id of ["a", "b"]) {
    painter.paint(metrics, frame(image(id)));
    await flush();
  }
  painter.paint(metrics, frame(image("a", false)));
  painter.paint(metrics, frame(image("c")));
  await flush();
  expect(closed).toEqual(["b"]);
  painter.paint(metrics, frame(image("b", false)));
  painter.paint(metrics, frame(image("b", false)));
  expect(misses).toEqual([["b"]]);
  painter.paint(metrics, frame(image("b")), undefined, ["b"]);
  await flush();
  expect(decodes).toBe(4);
  painter.dispose();
  expect(closed.sort()).toEqual(["a", "b", "b", "c"]);
});

test("current images may exceed soft limits without an eviction or decode loop", async () => {
  const closed: string[] = [];
  let decodes = 0;
  let redraws = 0;
  const painter = new CanvasSurfacePainter({
    maxDecodedImageCacheEntries: 1,
    maxDecodedImageCacheBytes: 1,
    decodeImage: async (_payload, _format, id) => {
      decodes++;
      return decoded(id, closed, 100);
    },
  });
  painter.attach(canvas, () => {
    redraws++;
  });
  painter.paint(metrics, frame(image("a"), image("b")));
  await flush();
  for (let count = 0; count < 5; count++) {
    painter.paint(metrics, frame(image("a", false), image("b", false)));
  }
  expect(closed).toEqual([]);
  expect(decodes).toBe(2);
  expect(redraws).toBe(2);
  painter.paint(metrics, frame());
  expect(closed.sort()).toEqual(["a", "b"]);
});

test("entry limit bounds decoded objects whose dimensions are unavailable", async () => {
  const closed: string[] = [];
  const painter = new CanvasSurfacePainter({
    maxDecodedImageCacheEntries: 2,
    decodeImage: async (_payload, _format, id) =>
      ({ close: () => closed.push(id) }) as unknown as CanvasImageSource,
  });
  painter.attach(canvas, () => {});
  for (let i = 0; i < 10; i++) {
    painter.paint(metrics, frame(image(String(i))));
    await flush();
  }
  painter.paint(metrics, frame());
  expect(closed).toHaveLength(8);
  painter.dispose();
  painter.dispose();
  expect(new Set(closed).size).toBe(10);
  expect(closed).toHaveLength(10);
});

test("disposal closes retained and late decoded images and suppresses redraw and recovery", async () => {
  const closed: string[] = [];
  let resolvePending!: (image: CanvasImageSource) => void;
  let redraws = 0;
  const misses: string[][] = [];
  const painter = new CanvasSurfacePainter({
    decodeImage: async (_payload, _format, id) =>
      id === "pending"
        ? new Promise((resolve) => {
            resolvePending = resolve;
          })
        : decoded(id, closed),
    onImagePayloadMiss: (ids) => {
      misses.push([...ids]);
    },
  });
  painter.attach(canvas, () => {
    redraws++;
  });
  painter.paint(metrics, frame(image("retained")));
  await flush();
  painter.paint(metrics, frame(image("pending")));
  painter.dispose();
  painter.dispose();
  resolvePending(decoded("pending", closed));
  await flush();
  painter.paint(metrics, frame(image("missing", false)));
  expect(closed.sort()).toEqual(["pending", "retained"]);
  expect(redraws).toBe(1);
  expect(misses).toEqual([]);
});

test("a decode completing after its image disappeared releases its result", async () => {
  const closed: string[] = [];
  let resolvePending!: (image: CanvasImageSource) => void;
  let redraws = 0;
  const painter = new CanvasSurfacePainter({
    decodeImage: () =>
      new Promise((resolve) => {
        resolvePending = resolve;
      }),
  });
  painter.attach(canvas, () => {
    redraws++;
  });
  painter.paint(metrics, frame(image("departed")));
  painter.paint(metrics, frame());
  resolvePending(decoded("departed", closed));
  await flush();
  expect(closed).toEqual(["departed"]);
  expect(redraws).toBe(0);
});

test("images whose ids exceed the recovery limit are retained rather than evicted", async () => {
  const closed: string[] = [];
  const longId = "x".repeat(MAX_IMAGE_RECOVERY_ID_BYTES + 1);
  const painter = new CanvasSurfacePainter({
    maxDecodedImageCacheBytes: 1,
    decodeImage: async (_payload, _format, id) => decoded(id, closed),
  });
  painter.attach(canvas, () => {});
  for (const id of [longId, "b", "c"]) {
    painter.paint(metrics, frame(image(id)));
    await flush();
  }
  // "b" is inactive and recoverable, so the byte budget evicts it; the long id
  // could never be requested again, so it stays decoded past the budget.
  expect(closed).toEqual(["b"]);
  painter.paint(metrics, frame(image(longId, false)));
  // "c" leaves the frame and is evicted; the long id is visible and cached.
  expect(closed).toEqual(["b", "c"]);
  painter.dispose();
  expect(closed).toEqual(["b", "c", longId]);
});
