import { expect, test } from "@playwright/test";
import type {
  WebHostSurfaceFrame,
  WebHostSurfaceLineStyle,
} from "../src/WebHostSurfaceTransport.ts";
import type {} from "./dom-fidelity.fixture.ts";

const patterns: WebHostSurfaceLineStyle["pattern"][] = [
  "solid",
  "dot",
  "dash",
  "dashDot",
  "dashDotDot",
  "double",
  "curly",
];
const frame: WebHostSurfaceFrame = {
  version: 2,
  width: 7,
  height: 2,
  styles: patterns.map((pattern) => ({
    fg: "#112233",
    underline: { pattern, color: "#ff0000" },
    strikethrough: { pattern, color: "#00ff00" },
    opacity: 0.75,
  })),
  rows: [
    patterns.map((_, x) => [x, "X", 1, x]),
    patterns.map((_, x) => [x, "█", 1, x]),
  ],
};
test.beforeEach(async ({ page }) => {
  await page.goto("/health");
  await page.addScriptTag({ url: "/dom-fidelity.js", type: "module" });
  await page.waitForFunction(() => !!window.domFidelity);
});

test("browser find crosses style and link boundaries exactly once", async ({
  page,
}) => {
  const word: WebHostSurfaceFrame = {
    version: 2,
    width: 6,
    height: 1,
    styles: [null, { em: 1, fg: "#bb2233" }, { em: 2 }],
    rows: [[..."findme"].map((c, x) => [x, c, 1, x % 3])],
    links: [[0, [[2, 2, 0]]]],
    linkTargets: ["https://example.test/find"],
  };
  await page.evaluate((frame) => window.domFidelity.paint(frame), word);
  expect(
    await page.evaluate(() => {
      const finder = (
        window as unknown as {
          find(
            text: string,
            matchCase: boolean,
            backwards: boolean,
            wrap: boolean,
          ): boolean;
        }
      ).find.bind(window);
      document.getSelection()?.removeAllRanges();
      return [
        finder("findme", true, false, false),
        finder("findme", true, false, false),
      ];
    }),
  ).toEqual([true, false]);
});

test("coalesced text retains a live Range through changes outside the selection", async ({
  page,
}) => {
  const result = await page.evaluate(() => {
    HTMLCanvasElement.prototype.getContext = () => {
      throw new Error("DOM selection requested Canvas");
    };
    const frame: WebHostSurfaceFrame = {
      version: 2,
      width: 16,
      height: 1,
      styles: [null],
      rows: [[..."select--outside!"].map((text, x) => [x, text, 1, 0])],
    };
    window.domFidelity.paint(frame);
    const row = document.querySelector(".webhost-scene__surface-row")!;
    const node = row.firstChild!.firstChild!;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, 6);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    frame.rows[0]![14]![1] = "X";
    window.domFidelity.paint(frame);
    const retained =
      row.childElementCount === 1 &&
      row.firstChild!.firstChild === node &&
      selection.getRangeAt(0) === range &&
      selection.toString() === "select";
    frame.rows[0]![2]![1] = "X";
    window.domFidelity.paint(frame);
    return { retained, selected: selection.toString(), text: row.textContent };
  });
  expect(result).toEqual({
    retained: true,
    selected: "",
    text: "seXect--outsidX!",
  });
});

test("every decoration pattern retains independent colors on text and geometric cells", async ({
  page,
}) => {
  await page.evaluate((frame) => window.domFidelity.paint(frame), frame);
  const original = await page.evaluate(() => window.domFidelity.state());
  for (const cell of original.cells) {
    expect(cell.svg).toContain("#ff0000");
    expect(cell.svg).toContain("#00ff00");
    expect(cell.opacity).toBe("0.75");
  }
  expect(original.cells[0]?.color).toBe("rgb(17, 34, 51)");
  const changed = structuredClone(frame);
  changed.rows[0]![3]![1] = "Y";
  await page.evaluate(
    (frame) =>
      window.domFidelity.paint(frame, {
        textRows: [[0, [[3, 1]]]],
        requiresFullTextRepaint: false,
        requiresFullGraphicsReplay: false,
      }),
    changed,
  );
  const partial = await page.evaluate(() => window.domFidelity.state());
  await page.evaluate(() => window.domFidelity.refresh());
  const full = await page.evaluate(() => window.domFidelity.state());
  expect(partial.cells).toEqual(full.cells);
  expect(partial.stats.decorationNodes).toBe(14);
  expect(partial.stats.geometryCacheEntries).toBeLessThanOrEqual(512);
});

test("unrelated damage and identical full repaint leave retained rows untouched under adverse page CSS", async ({
  page,
}) => {
  await page.addStyleTag({
    content:
      "span,a,img,div {box-sizing:content-box;margin:17px;padding:23px;border:7px solid red;font:43px serif;line-height:65px;letter-spacing:3px;text-align:right;white-space:normal;min-width:80px;max-height:5px;float:right;}",
  });
  await page.evaluate((frame) => {
    window.domFidelity.paint(frame);
    window.domFidelity.watchRow(1);
  }, frame);
  const before = await page
    .locator(".webhost-scene__surface-row")
    .nth(1)
    .boundingBox();
  const cell = await page
    .locator(".webhost-scene__surface-row")
    .nth(1)
    .locator("span")
    .first()
    .boundingBox();
  expect(cell?.x).toBe(before?.x);
  expect(cell!.height).toBeLessThanOrEqual(24);
  const changed = structuredClone(frame);
  changed.rows[0]![0]![1] = "Y";
  await page.evaluate(
    (frame) =>
      window.domFidelity.paint(frame, {
        textRows: [[0, [[0, 1]]]],
        requiresFullTextRepaint: false,
        requiresFullGraphicsReplay: false,
      }),
    changed,
  );
  await page.evaluate(() => window.domFidelity.refresh());
  expect(
    (await page.evaluate(() => window.domFidelity.state())).rowMutations,
  ).toBe(0);
  expect(
    await page.locator(".webhost-scene__surface-row").nth(1).boundingBox(),
  ).toEqual(before);
});

test("forced colors replace authored colors for text, geometric ink and independent decorations", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName === "webkit",
    "WebKit does not implement forced-colors emulation; real Windows lane is required",
  );
  await page.emulateMedia({
    forcedColors: "active",
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  await page.evaluate((frame) => window.domFidelity.paint(frame), frame);
  const state = await page.evaluate(() => window.domFidelity.state());
  for (const cell of state.cells) {
    expect(cell.svg).toContain(state.cells[0]!.color);
    expect(cell.svg).not.toContain("#ff0000");
    expect(cell.svg).not.toContain("#00ff00");
    expect(cell.forcedColorAdjust).toBe("none");
    expect(cell.opacity).toBe("1");
  }
  expect(state.cells[0]?.color).not.toBe("rgba(0, 0, 0, 0)");
  await page.emulateMedia({ forcedColors: "active", colorScheme: "light" });
  await page.evaluate(() => window.domFidelity.refresh());
  const light = await page.evaluate(() => window.domFidelity.state());
  expect(light.cells[0]?.color).toBe(light.systemForeground);
  for (const cell of light.cells)
    expect(cell.svg).toContain(light.systemForeground);
});

test("retained image order, duplicate placement, removal and late completion are bounded", async ({
  page,
}) => {
  const payload =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=";
  const images: NonNullable<WebHostSurfaceFrame["images"]> = [
    "a",
    "b",
    "a",
  ].map((id, x) => ({
    id,
    format: "png",
    bounds: [x, 0, 2, 2],
    visibleBounds: [x, 0, 1, 2],
    scalingMode: "stretch",
    opacity: 0.5,
    dataBase64: payload,
  }));
  const imageFrame = { ...frame, images };
  await page.evaluate((frame) => window.domFidelity.paint(frame), imageFrame);
  await expect
    .poll(() =>
      page.evaluate(() => window.domFidelity.state().stats.pendingImages),
    )
    .toBe(0);
  await page.evaluate(() => window.domFidelity.saveImages());
  await page.evaluate(
    (frame) =>
      window.domFidelity.paint({
        ...frame,
        images: [frame.images![1]!, frame.images![0]!, frame.images![2]!],
      }),
    imageFrame,
  );
  const reordered = await page.evaluate(() => window.domFidelity.state());
  expect(reordered.images.map((image) => image.x)).toEqual([
    "10px",
    "0px",
    "20px",
  ]);
  expect(reordered.images.every((image) => image.sameNode)).toBe(true);
  expect(reordered.stats.decodedImageBytes).toBe(12);
  await page.evaluate((frame) => {
    window.domFidelity.paint({ ...frame, images: [] });
    window.domFidelity.lateLoads();
  }, imageFrame);
  expect(
    (await page.evaluate(() => window.domFidelity.state())).stats.imageNodes,
  ).toBe(0);
  await page.evaluate(() => window.domFidelity.dispose());
  await page.evaluate(() => new Promise(requestAnimationFrame));
  const before = await page.evaluate(
    () => window.domFidelity.state().mutations,
  );
  await page.evaluate(() => window.domFidelity.lateLoads());
  await page.evaluate(() => new Promise(requestAnimationFrame));
  const after = await page.evaluate(() => window.domFidelity.state());
  expect(after.mutations).toBe(before);
  expect(after.stats).toMatchObject({
    cells: 0,
    rows: 0,
    imageNodes: 0,
    decodedImageBytes: 0,
    retainedPayloadBytes: 0,
  });
});

test("raw animated GIF stays on its first red frame in both browser painters", async ({
  page,
}) => {
  const header = [
    71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, 255, 0, 0, 0, 0, 255,
  ];
  const loop = [
    33,
    255,
    11,
    ...new TextEncoder().encode("NETSCAPE2.0"),
    3,
    1,
    0,
    0,
    0,
  ];
  const first = [
    33, 249, 4, 0, 5, 0, 0, 0, 44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 68, 1, 0,
  ];
  const second = [...first];
  second[20] = 76;
  const dataBase64 = Buffer.from([
    ...header,
    ...loop,
    ...first,
    ...second,
    59,
  ]).toString("base64");
  const gifFrame: WebHostSurfaceFrame = {
    ...frame,
    images: [
      {
        id: "raw-gif",
        format: "gif",
        bounds: [0, 0, 1, 1],
        visibleBounds: [0, 0, 1, 1],
        scalingMode: "stretch",
        dataBase64,
      },
    ],
  };
  await page.evaluate(
    (frame) => window.domFidelity.compareImage(frame),
    gifFrame,
  );
  await expect
    .poll(() =>
      page.evaluate(() => window.domFidelity.state().stats.pendingImages),
    )
    .toBe(0);
  const expected = { dom: [255, 0, 0, 255], canvas: [255, 0, 0, 255] };
  await expect
    .poll(() => page.evaluate(() => window.domFidelity.imagePixels()))
    .toEqual(expected);
  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(110);
    expect(await page.evaluate(() => window.domFidelity.imagePixels())).toEqual(
      expected,
    );
  }
});

test("aggregate decoded image admission and missing-payload recovery stay bounded", async ({
  page,
}) => {
  const payload = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 4096;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "red";
    context.fillRect(0, 0, 4096, 4096);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  const imageFrame: WebHostSurfaceFrame = {
    ...frame,
    images: ["first", "second"].map((id) => ({
      id,
      format: "png",
      bounds: [0, 0, 1, 1],
      visibleBounds: [0, 0, 1, 1],
      scalingMode: "stretch",
      dataBase64: payload,
    })),
  };
  await page.evaluate((frame) => window.domFidelity.paint(frame), imageFrame);
  await expect
    .poll(() =>
      page.evaluate(() => window.domFidelity.state().stats.pendingImages),
    )
    .toBe(0);
  expect(
    await page.evaluate(() => window.domFidelity.state().stats),
  ).toMatchObject({
    imageNodes: 2,
    decodedImageBytes: 64 * 1024 * 1024,
    failedImages: 0,
    rejectedImages: 1,
  });
  expect(
    (await page.evaluate(() => window.domFidelity.state())).diagnostics,
  ).toHaveLength(1);
  await page.evaluate(
    (frame) => window.domFidelity.paint({ ...frame, images: [] }),
    frame,
  );
  expect(
    (await page.evaluate(() => window.domFidelity.state())).stats
      .decodedImageBytes,
  ).toBe(0);
  const missing = {
    ...imageFrame,
    images: [{ ...imageFrame.images![0]!, dataBase64: undefined }],
  };
  await page.evaluate((frame) => {
    window.domFidelity.paint(frame);
    window.domFidelity.refresh();
  }, missing);
  expect(
    (await page.evaluate(() => window.domFidelity.state())).misses,
  ).toEqual([["first"]]);
  await page.evaluate(
    (frame) =>
      window.domFidelity.paint(
        { ...frame, images: frame.images!.slice(0, 1) },
        {
          textRows: [],
          requiresFullTextRepaint: false,
          requiresFullGraphicsReplay: true,
        },
      ),
    imageFrame,
  );
  await expect
    .poll(() =>
      page.evaluate(() => window.domFidelity.state().images[0]?.state),
    )
    .toBe("ready");
  await page.evaluate(() => window.domFidelity.dispose());
  expect(
    (await page.evaluate(() => window.domFidelity.state())).stats,
  ).toMatchObject({
    imageNodes: 0,
    decodedImageBytes: 0,
    retainedPayloadBytes: 0,
  });
});

test("the admitted maximum grid completes with bounded text ownership and releases it", async ({
  page,
}, info) => {
  const result = await page.evaluate(() => {
    HTMLCanvasElement.prototype.getContext = () => {
      throw new Error("DOM maximum grid requested Canvas");
    };
    const start = performance.now();
    window.domFidelity.paint({
      version: 2,
      width: 1024,
      height: 64,
      styles: [null, { em: 1 }, { em: 2 }, { em: 3 }],
      rows: Array.from({ length: 64 }, () =>
        Array.from({ length: 1024 }, (_, x) => [x, "W", 1, x % 4]),
      ),
    });
    const state = window.domFidelity.ownership();
    const populated = {
      elapsed: performance.now() - start,
      stats: state.stats,
      textLength: state.textLength,
    };
    window.domFidelity.dispose();
    return { populated, disposed: window.domFidelity.state().stats };
  });
  expect(result.populated.stats.cells).toBe(65536);
  expect(result.populated.stats.rows).toBe(64);
  expect(result.populated.stats.textAdvanceCacheEntries).toBeLessThanOrEqual(4);
  expect(result.populated.textLength).toBe(65536 + 63);
  expect(result.disposed).toMatchObject({
    rows: 0,
    cells: 0,
    decorationNodes: 0,
    textAdvanceCacheEntries: 0,
  });
  await info.attach("maximum-grid", {
    body: JSON.stringify(result),
    contentType: "application/json",
  });
});
