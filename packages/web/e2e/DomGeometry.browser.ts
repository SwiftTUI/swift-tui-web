import { expect, test } from "@playwright/test";
import type {} from "./dom-geometry.fixture.ts";

test.beforeEach(async ({ page }) => {
  await page.goto("/health");
  await page.addScriptTag({ url: "/dom-geometry.js", type: "module" });
  await page.waitForFunction(() => !!window.domGeometryJourney);
});

test("font ownership is shared, hidden mounts defer and disposed sessions cannot publish", async ({
  page,
}) => {
  const id = await page.evaluate(() =>
    window.domGeometryJourney.create(undefined, true),
  );
  await page.evaluate((id) => window.domGeometryJourney.ready(id), id);
  let result = await page.evaluate(
    (id) => window.domGeometryJourney.state(id),
    id,
  );
  expect(result.font?.status).toBe("ready");
  expect(result.geometry).toBeUndefined();
  expect(result.inputs.filter((x) => x.includes("resize"))).toEqual([]);
  await page.evaluate(
    (id) =>
      window.domGeometryJourney.style(id, "width:2800.5px;height:400.25px"),
    id,
  );
  await page.evaluate(() => window.domGeometryJourney.settle());
  result = await page.evaluate((id) => window.domGeometryJourney.state(id), id);
  expect(result.geometry?.columns).toBeGreaterThan(200);
  expect(result.faces).toBe(4);
  const second = await page.evaluate(() => window.domGeometryJourney.create());
  await page.evaluate((id) => window.domGeometryJourney.ready(id), second);
  expect(
    (await page.evaluate((id) => window.domGeometryJourney.state(id), second))
      .font?.family,
  ).toBe(result.font?.family);
  await page.evaluate((id) => window.domGeometryJourney.dispose(id), id);
  expect(
    (await page.evaluate((id) => window.domGeometryJourney.state(id), second))
      .faces,
  ).toBe(4);
  await page.evaluate((id) => window.domGeometryJourney.dispose(id), second);
  expect(
    (await page.evaluate((id) => window.domGeometryJourney.state(id), second))
      .faces,
  ).toBe(0);
});

test("failed and late fonts settle once to a distinct measured fallback", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/fonts/**", async (route) => {
    await gate;
    await route.continue();
  });
  const id = await page.evaluate(() =>
    window.domGeometryJourney.create({ assetBase: "/fonts/", timeoutMs: 40 }),
  );
  await page.evaluate((id) => window.domGeometryJourney.ready(id), id);
  const initial = await page.evaluate(
    (id) => window.domGeometryJourney.state(id),
    id,
  );
  expect(initial.font?.status).toBe("fallback");
  expect(initial.geometry).toBeDefined();
  expect(initial.busy).toBeNull();
  release();
  await page.unrouteAll({ behavior: "wait" });
  await page.evaluate(() => window.domGeometryJourney.settle());
  const after = await page.evaluate(
    (id) => window.domGeometryJourney.state(id),
    id,
  );
  expect(after.font).toEqual(initial.font);
  expect(after.faces).toBe(0);
  expect(after.geometry?.cellWidth).toBe(initial.geometry?.cellWidth);
});

test("a queued first frame becomes visible by the first animation frame after font readiness", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/fonts/**", async (route) => {
    await gate;
    await route.continue();
  });
  const id = await page.evaluate(async () => {
    const id = await window.domGeometryJourney.create();
    window.domGeometryJourney.present(id);
    return id;
  });
  const pending = await page.evaluate(
    (id) => window.domGeometryJourney.state(id),
    id,
  );
  expect(pending.geometry).toBeUndefined();
  expect(pending.text).toBe("");
  expect(pending.busy).toBe("true");
  release();
  // ready awaits the font transaction, then exactly one available RAF.
  await page.evaluate((id) => window.domGeometryJourney.ready(id), id);
  const ready = await page.evaluate(
    (id) => window.domGeometryJourney.state(id),
    id,
  );
  expect(ready.font?.status).toBe("ready");
  expect(ready.geometry).toBeDefined();
  expect(ready.text?.length).toBeGreaterThan(0);
  expect(ready.busy).toBeNull();
});

test("style replacement, malformed fonts and disposal settle bounded ownership", async ({
  page,
}) => {
  const id = await page.evaluate(() => window.domGeometryJourney.create());
  await page.evaluate((id) => window.domGeometryJourney.ready(id), id);
  const initial = await page.evaluate(
    (id) => window.domGeometryJourney.state(id),
    id,
  );
  await page.evaluate((id) => {
    window.domGeometryJourney.setFont(id, 24);
    window.domGeometryJourney.setFont(id, 32);
  }, id);
  await page.evaluate((id) => window.domGeometryJourney.ready(id), id);
  const enlarged = await page.evaluate(
    (id) => window.domGeometryJourney.state(id),
    id,
  );
  expect(enlarged.geometry!.fontSize).toBe(32);
  expect(enlarged.geometry!.cellWidth).toBeGreaterThan(
    initial.geometry!.cellWidth,
  );
  expect(enlarged.faces).toBe(4);
  expect(enlarged.font?.family).toBe(initial.font?.family);
  await page.evaluate(
    (id) => window.domGeometryJourney.setFont(id, 16, "serif; color:red"),
    id,
  );
  await page.evaluate((id) => window.domGeometryJourney.ready(id), id);
  const fallback = await page.evaluate(
    (id) => window.domGeometryJourney.state(id),
    id,
  );
  expect(fallback.font?.status).toBe("fallback");
  expect(fallback.busy).toBeNull();
  expect(fallback.faces).toBe(0);
  await page.evaluate((id) => window.domGeometryJourney.dispose(id), id);
  expect(await page.locator(".webhost-scene").count()).toBe(0);
});

test("pending font disposal never attaches faces or emits a resize", async ({
  page,
}) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/fonts/**", async (route) => {
    await gate;
    await route.continue();
  });
  const id = await page.evaluate(() => window.domGeometryJourney.create());
  await page.evaluate((id) => window.domGeometryJourney.dispose(id), id);
  release();
  await page.unrouteAll({ behavior: "wait" });
  await page.evaluate(() => window.domGeometryJourney.settle());
  const result = await page.evaluate(
    (id) => window.domGeometryJourney.state(id),
    id,
  );
  expect(result.faces).toBe(0);
  expect(result.inputs.filter((x) => x.includes("resize"))).toEqual([]);
});

test("standalone resizable chrome with hidden header boots an empty DOM surface", async ({
  page,
}) => {
  await page.addStyleTag({
    content: ".webhost-scene__header { display:none }",
  });
  const id = await page.evaluate(() =>
    window.domGeometryJourney.create(undefined, false, "resizable"),
  );
  await page.evaluate((id) => window.domGeometryJourney.ready(id), id);
  const result = await page.evaluate(
    (id) => window.domGeometryJourney.state(id),
    id,
  );
  expect(result.font?.status).toBe("ready");
  expect(result.geometry!.rows).toBeGreaterThan(8);
  expect(result.inputs.some((x) => x.startsWith("resize:"))).toBe(true);
});

for (const face of ["Regular", "Bold", "Italic", "BoldItalic"]) {
  test(`failure of the ${face} face selects a complete measured fallback`, async ({
    page,
  }) => {
    await page.route(`**/fonts/SwiftTUICoreCandidate3-${face}.woff2`, (route) =>
      route.abort("failed"),
    );
    const id = await page.evaluate(() => window.domGeometryJourney.create());
    await page.evaluate((id) => window.domGeometryJourney.ready(id), id);
    const result = await page.evaluate(
      (id) => window.domGeometryJourney.state(id),
      id,
    );
    expect(result.font?.status).toBe("fallback");
    expect(result.geometry!.cellWidth).toBeGreaterThan(0);
    expect(result.faces).toBe(0);
  });
}

test("offline embeds reuse settled faces and unrelated late fonts cannot change pitch", async ({
  page,
  context,
}) => {
  const id = await page.evaluate(() => window.domGeometryJourney.create());
  await page.evaluate((id) => window.domGeometryJourney.ready(id), id);
  const before = await page.evaluate(
    (id) => window.domGeometryJourney.state(id),
    id,
  );
  await page.evaluate(async () => {
    const unrelated = new FontFace(
      "Unrelated document font",
      "url(/fonts/SwiftTUICoreCandidate3-Regular.woff2)",
    );
    document.fonts.add(unrelated);
    await unrelated.load();
    await window.domGeometryJourney.settle();
  });
  expect(
    (await page.evaluate((id) => window.domGeometryJourney.state(id), id))
      .geometry!.cellWidth,
  ).toBe(before.geometry!.cellWidth);
  await context.setOffline(true);
  const second = await page.evaluate(() => window.domGeometryJourney.create());
  await page.evaluate((id) => window.domGeometryJourney.ready(id), second);
  const offline = await page.evaluate(
    (id) => window.domGeometryJourney.state(id),
    second,
  );
  expect(offline.font?.status).toBe("ready");
  expect(offline.font?.family).toBe(before.font?.family);
  await context.setOffline(false);
});

test("unsupported transforms defer and report an actionable embedding diagnostic", async ({
  page,
}) => {
  const id = await page.evaluate(() => window.domGeometryJourney.create());
  await page.evaluate((id) => window.domGeometryJourney.ready(id), id);
  const before = await page.evaluate(
    (id) => window.domGeometryJourney.state(id),
    id,
  );
  for (const transform of [
    "rotate(1deg)",
    "skewX(4deg)",
    "scale(-1,1)",
    "perspective(500px) rotateY(2deg)",
  ]) {
    await page.evaluate(
      ({ id, transform }) =>
        window.domGeometryJourney.style(
          id,
          `width:2800px;height:400px;transform:${transform}`,
        ),
      { id, transform },
    );
    await page.evaluate(() => window.domGeometryJourney.settle());
    const after = await page.evaluate(
      (id) => window.domGeometryJourney.state(id),
      id,
    );
    expect(after.geometry).toEqual(before.geometry);
    expect(await page.locator(".webhost-scene").innerText()).toContain(
      "positive axis-aligned",
    );
  }
});

test("narrow flex and grid embeds, hostile page CSS and text enlargement remeasure", async ({
  page,
}) => {
  await page.addStyleTag({
    content:
      "span { padding:18px; margin:9px; border:2px solid; font:30px serif; letter-spacing:3px; text-transform:lowercase }",
  });
  const id = await page.evaluate(() => window.domGeometryJourney.create());
  await page.evaluate((id) => window.domGeometryJourney.ready(id), id);
  for (const display of ["flex", "grid"]) {
    await page.evaluate(
      ({ id, display }) =>
        window.domGeometryJourney.style(
          id,
          `display:${display};width:319.5px;height:200.25px;min-width:0`,
        ),
      { id, display },
    );
    await page.evaluate(() => window.domGeometryJourney.settle());
    const before = await page.evaluate(
      (id) => window.domGeometryJourney.state(id),
      id,
    );
    expect(before.geometry!.content.width).toBeLessThanOrEqual(319.5);
    await page.evaluate((id) => window.domGeometryJourney.present(id), id);
    await page.evaluate(() => window.domGeometryJourney.settle());
    const cell = page
      .locator(".webhost-scene__surface-row")
      .first()
      .locator("span")
      .first();
    expect(await cell.evaluate((e) => getComputedStyle(e).fontSize)).toBe(
      "16px",
    );
    expect(await cell.evaluate((e) => getComputedStyle(e).padding)).toBe("0px");
  }
  await page.addStyleTag({
    content: ".webhost-scene__terminal span { font-size:32px !important }",
  });
  await page.evaluate(
    (id) =>
      window.domGeometryJourney.style(id, "width:319.5px;height:200.25px"),
    id,
  );
  await page.evaluate(() => window.domGeometryJourney.settle());
  const enlarged = await page.evaluate(
    (id) => window.domGeometryJourney.state(id),
    id,
  );
  expect(enlarged.geometry!.fontSize).toBe(32);
  expect(enlarged.geometry!.cellWidth).toBeGreaterThanOrEqual(19);
});

for (const dpr of [1, 1.25, 1.5, 2, 3]) {
  test.describe(`DOM geometry at output scale ${dpr}`, () => {
    test.use({ deviceScaleFactor: dpr });
    test("fractional padding, CSS zoom and axis-aligned transforms preserve one layout pitch", async ({
      page,
    }) => {
      const id = await page.evaluate(() => window.domGeometryJourney.create());
      await page.evaluate((id) => window.domGeometryJourney.ready(id), id);
      const before = await page.evaluate(
        (id) => window.domGeometryJourney.state(id),
        id,
      );
      for (const zoom of [0.8, 1, 1.25, 1.5, 1.75, 2, 3, 4]) {
        await page.evaluate(
          ({ id, zoom }) =>
            window.domGeometryJourney.style(
              id,
              `width:2800.5px;height:400.25px;zoom:${zoom};transform:translate(3.25px,2.5px) scale(1.1,1.2);transform-origin:0 0`,
              ";padding:3.5px 4.25px;border:1.25px solid transparent",
            ),
          { id, zoom },
        );
        await page.evaluate(() => window.domGeometryJourney.settle());
        await page.evaluate((id) => window.domGeometryJourney.present(id), id);
        await page.evaluate(() => window.domGeometryJourney.settle());
        const result = await page.evaluate(
          (id) => window.domGeometryJourney.state(id),
          id,
        );
        const g = result.geometry!;
        expect(g.cellWidth).toBe(before.geometry!.cellWidth);
        expect(g.cellHeight).toBe(before.geometry!.cellHeight);
        const rows = page.locator(".webhost-scene__surface-row");
        for (const y of [0, 7]) {
          for (const x of [1, 200]) {
            const rect = await rows.nth(y).evaluate((row, x) => {
              const cell = [...row.children].find((e) => {
                const start = Number(e.getAttribute("data-column"));
                return (
                  x >= start && x < start + Number(e.getAttribute("data-span"))
                );
              })!;
              const offset = x - Number(cell.getAttribute("data-column"));
              const range = document.createRange();
              range.setStart(cell.firstChild!, offset);
              range.setEnd(cell.firstChild!, offset + 1);
              const r = range.getBoundingClientRect();
              return { x: r.x, y: row.getBoundingClientRect().y };
            }, x);
            expect(
              Math.abs(
                (rect.x - g.content.left) / g.content.scaleX - x * g.cellWidth,
              ),
              JSON.stringify({ x, y, zoom, rect, geometry: g }),
              // WebKit rounds a partial Text Range outward in pre-transform
              // pixels. A whole run origin stays subpixel; interior selection
              // rectangles may precede the glyph by one unscaled pixel.
            ).toBeLessThanOrEqual(1 / zoom + 1 / 32);
            expect(
              Math.abs(
                (rect.y - g.content.top) / g.content.scaleY - y * g.cellHeight,
              ),
            ).toBeLessThanOrEqual(0.5);
          }
        }
        const point = await page.evaluate(
          (id) => window.domGeometryJourney.clientPoint(id, 1.25, 2.5),
          id,
        );
        await page.mouse.click(point.x, point.y);
        const inputs = (
          await page.evaluate((id) => window.domGeometryJourney.state(id), id)
        ).inputs;
        const down = inputs
          .filter((input) => input.startsWith("\u001emouse:down:"))
          .at(-1)!
          .trim()
          .split(":");
        // Browser injection can quantize the requested point to device pixels.
        // Validate the host's inverse against the event actually delivered.
        const client = inputs
          .filter((input) => input.startsWith("client:"))
          .at(-1)!
          .split(":");
        expect(Number(down[2])).toBeCloseTo(
          (Number(client[1]) - g.content.left) / g.content.scaleX / g.cellWidth,
          2,
        );
        expect(Number(down[3])).toBeCloseTo(
          (Number(client[2]) - g.content.top) / g.content.scaleY / g.cellHeight,
          2,
        );
        expect(Math.floor(Number(down[2]))).toBe(1);
        expect(Math.floor(Number(down[3]))).toBe(2);
      }
    });
  });
}
