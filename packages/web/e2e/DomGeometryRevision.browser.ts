import { expect, test } from "@playwright/test";
import type {} from "./dom-geometry.fixture.ts";

test("font changes retain the visible frame and semantic map until their correlated response", async ({
  page,
}) => {
  await page.goto("/health");
  await page.addScriptTag({ url: "/dom-geometry.js", type: "module" });
  await page.waitForFunction(() => !!window.domGeometryJourney);
  const id = await page.evaluate(() => window.domGeometryJourney.create());
  await page.evaluate((id) => window.domGeometryJourney.ready(id), id);
  expect(
    (
      await page.evaluate((id) => window.domGeometryJourney.state(id), id)
    ).inputs.some((input) => input.startsWith("\u001egeometry:")),
  ).toBe(false);
  const first = await page.evaluate((id) => {
    window.domGeometryJourney.acknowledge(id);
    const requested = window.domGeometryJourney.requested(id);
    window.domGeometryJourney.presentGeometry(id, requested, "A");
    return requested;
  }, id);
  await page.evaluate(() => window.domGeometryJourney.settle());
  const before = await page.evaluate(
    (id) => window.domGeometryJourney.state(id),
    id,
  );
  expect(before.geometry!.revision).toBe(first.revision);
  await expect(
    page.getByRole("button", { name: "A", exact: true }),
  ).toHaveCount(1);

  await page.evaluate((id) => window.domGeometryJourney.setFont(id, 20), id);
  await page.evaluate((id) => window.domGeometryJourney.ready(id), id);
  const second = await page.evaluate(
    (id) => window.domGeometryJourney.requested(id),
    id,
  );
  expect(second.revision).toBeGreaterThan(first.revision);
  const waiting = await page.evaluate(
    (id) => window.domGeometryJourney.state(id),
    id,
  );
  expect(waiting.geometry).toEqual(before.geometry);
  expect(waiting.text).toBe(before.text);
  expect(waiting.busy).toBe("true");
  await expect(
    page.getByRole("button", { name: "A", exact: true }),
  ).toHaveCount(1);
  const point = await page.evaluate(
    (id) => window.domGeometryJourney.clientPoint(id, 1.25, 2.5),
    id,
  );
  await page.mouse.click(point.x, point.y);
  expect(
    (
      await page.evaluate((id) => window.domGeometryJourney.state(id), id)
    ).inputs.some((input) =>
      input.startsWith(`\u001emouseGeometry:${first.revision}:down:`),
    ),
  ).toBe(true);

  await page.evaluate(
    ({ id, first, second }) => {
      window.domGeometryJourney.presentGeometry(id, first, "O");
      window.domGeometryJourney.presentGeometry(id, second, "N");
      window.domGeometryJourney.presentGeometry(id, first, "Z");
    },
    { id, first, second },
  );
  await page.evaluate(() => window.domGeometryJourney.settle());
  const after = await page.evaluate(
    (id) => window.domGeometryJourney.state(id),
    id,
  );
  expect(after.geometry!.revision).toBe(second.revision);
  expect(after.geometry!.fontSize).toBe(20);
  expect(after.text?.startsWith("N")).toBe(true);
  expect(after.text).not.toContain("Z");
  expect(after.busy).toBeNull();
  await expect(
    page.getByRole("button", { name: "N", exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "A", exact: true }),
  ).toHaveCount(0);
});

test("a press cannot finish against replacement geometry", async ({ page }) => {
  await page.goto("/health");
  await page.addScriptTag({ url: "/dom-geometry.js", type: "module" });
  await page.waitForFunction(() => !!window.domGeometryJourney);
  const id = await page.evaluate(() => window.domGeometryJourney.create());
  await page.evaluate((id) => window.domGeometryJourney.ready(id), id);
  const first = await page.evaluate((id) => {
    window.domGeometryJourney.acknowledge(id);
    const request = window.domGeometryJourney.requested(id);
    window.domGeometryJourney.presentGeometry(id, request, "A");
    return request;
  }, id);
  await page.evaluate(() => window.domGeometryJourney.settle());
  const point = await page.evaluate(
    (id) => window.domGeometryJourney.clientPoint(id, 1.25, 2.5),
    id,
  );
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.evaluate((id) => window.domGeometryJourney.setFont(id, 20), id);
  await page.evaluate((id) => window.domGeometryJourney.ready(id), id);
  await page.evaluate(
    (id) =>
      window.domGeometryJourney.presentGeometry(
        id,
        window.domGeometryJourney.requested(id),
        "N",
      ),
    id,
  );
  await page.evaluate(() => window.domGeometryJourney.settle());
  await page.mouse.up();
  const inputs = (
    await page.evaluate((id) => window.domGeometryJourney.state(id), id)
  ).inputs;
  expect(
    inputs.filter((input) =>
      input.startsWith(`\u001emouseGeometry:${first.revision}:down:`),
    ),
  ).toHaveLength(1);
  expect(
    inputs.filter(
      (input) =>
        input.startsWith("\u001emouseGeometry:") &&
        /^mouseGeometry:\d+:up:/.test(input.slice(1)),
    ),
  ).toHaveLength(0);
});

test("user text enlargement reprojects every layer with an explicit source revision", async ({
  page,
}) => {
  await page.goto("/health");
  await page.addScriptTag({ url: "/dom-geometry.js", type: "module" });
  await page.waitForFunction(() => !!window.domGeometryJourney);
  const id = await page.evaluate(() => window.domGeometryJourney.create());
  await page.evaluate((id) => window.domGeometryJourney.ready(id), id);
  const first = await page.evaluate((id) => {
    window.domGeometryJourney.acknowledge(id);
    const request = window.domGeometryJourney.requested(id);
    window.domGeometryJourney.presentGeometry(id, request, "A");
    return request;
  }, id);
  await page.evaluate(() => window.domGeometryJourney.settle());
  await page.addStyleTag({
    content: ".webhost-scene__terminal span { font-size: 28px !important }",
  });
  await page.evaluate(() => window.domGeometryJourney.settle());
  const pending = await page.evaluate(
    (id) => window.domGeometryJourney.state(id),
    id,
  );
  expect(pending.geometry?.projected).toBe(true);
  expect(pending.geometry?.sourceRevision).toBe(first.revision);
  expect(pending.geometry!.revision).toBeGreaterThan(first.revision);
  expect(pending.geometry!.cellWidth).toBeGreaterThan(first.cellWidth);
  expect(pending.busy).toBe("true");
  const rect = await page
    .getByRole("button", { name: "A", exact: true })
    .boundingBox();
  expect(rect!.width).toBeCloseTo(pending.geometry!.cellWidth * 2, 1);
  await expect(page.locator(".webhost-scene")).toContainText(
    "Waiting for the app to finish layout",
    { timeout: 2000 },
  );
  const second = await page.evaluate((id) => {
    const request = window.domGeometryJourney.requested(id);
    window.domGeometryJourney.presentGeometry(id, request, "N");
    return request;
  }, id);
  await page.evaluate(() => window.domGeometryJourney.settle());
  const final = await page.evaluate(
    (id) => window.domGeometryJourney.state(id),
    id,
  );
  expect(final.geometry?.projected).toBeUndefined();
  expect(final.geometry?.sourceRevision).toBe(second.revision);
  expect(final.busy).toBeNull();
});

test("compiled Swift DOM frames echo captured geometry through resize and same-grid font changes", async ({
  page,
}, info) => {
  await page.goto("/compiled-wasm.html");
  await page.waitForFunction(() => !!window.__compiledWasm);
  await page.evaluate(() =>
    window.__compiledWasm.start("worker", "alpha", undefined, "dom"),
  );
  await page.waitForFunction(
    () => !!window.__compiledWasm.snapshot().frames.alpha,
  );
  const first = await page.evaluate(() => window.__compiledWasm.snapshot());
  test.skip(
    first.frames.alpha?.geometryRevision === undefined,
    "released Swift fixture predates geometryRevisions; org worktree lane runs the new producer",
  );
  await page.waitForFunction(() => {
    const state = window.__compiledWasm.snapshot();
    return (
      (state.geometry[0]?.revision ?? 0) > 0 &&
      state.frames.alpha?.geometryRevision === state.geometry[0]?.revision
    );
  });
  const before = await page.evaluate(() => window.__compiledWasm.snapshot());
  await page.evaluate(() => {
    window.__compiledWasm.setFontSize(20);
    for (let i = 0; i < 12; i++)
      window.__compiledWasm.resizeMount(320 + i * 10, 240 + i * 2);
  });
  await page.waitForFunction((revision) => {
    const state = window.__compiledWasm.snapshot();
    return (
      (state.geometry[0]?.revision ?? 0) > revision &&
      state.geometry[0]?.fontSize === 20 &&
      state.frames.alpha?.geometryRevision === state.geometry[0]?.revision
    );
  }, before.geometry[0]!.revision);
  const after = await page.evaluate(() => window.__compiledWasm.snapshot());
  expect(after.frames.alpha?.width).toBe(after.geometry[0]?.columns);
  expect(after.frames.alpha?.height).toBe(after.geometry[0]?.rows);
  expect(after.errors).toEqual([]);
  await page.locator(".webhost-scene__terminal:visible").focus();
  await page.keyboard.press("Tab");
  for (let i = 0; i < 24; i++) {
    await page.evaluate((i) => {
      window.__compiledWasm.resizeMount(400 + (i % 3) * 30, 260 + (i % 2) * 20);
      window.__compiledWasm.resizeMount(401 + (i % 3) * 30, 261 + (i % 2) * 20);
    }, i);
    await page.keyboard.press("Enter");
  }
  await page.waitForFunction(() => {
    const state = window.__compiledWasm.snapshot();
    return (
      state.geometryTimings.at(-1)?.painted !== undefined &&
      state.frames.alpha?.rows
        .map((row) => row.map((cell) => cell[1]).join(""))
        .join("\n")
        .includes("Alpha count 24")
    );
  });
  const continuous = await page.evaluate(() =>
    window.__compiledWasm.snapshot(),
  );
  expect(
    continuous.sentInputs.filter(
      (input) =>
        input.startsWith("\u001ekey:return:") || input.endsWith(":activate\n"),
    ),
  ).toHaveLength(24);
  const perAnimationFrame = new Map<number, number>();
  for (const timing of continuous.geometryTimings)
    perAnimationFrame.set(
      timing.animationFrame,
      (perAnimationFrame.get(timing.animationFrame) ?? 0) + 1,
    );
  expect(Math.max(...perAnimationFrame.values())).toBe(1);
  const final = continuous.geometryTimings.at(-1)!;
  // Timing acceptance runs on the named idle reference machine. The ordinary
  // functional suite can run beside native builds; it still records every
  // sample and requires exact, correlated final geometry and all 24 actions.
  if (process.env.SWIFTTUI_DOM_QUALIFY === "1")
    expect(final.painted! - continuous.finalSizeDelivered).toBeLessThanOrEqual(
      150,
    );
  await info.attach("captured-geometry", {
    body: JSON.stringify({
      before: before.geometry,
      after: after.geometry,
      frame: after.frames.alpha,
      continuous,
    }),
    contentType: "application/json",
  });
  await page.evaluate(() => window.__compiledWasm.dispose());
});
