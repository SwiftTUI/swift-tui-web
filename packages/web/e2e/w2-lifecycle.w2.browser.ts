// W2 lifecycle journeys: visibility/paint batching (w2s029–w2s035) and
// reconnect/backlog at the browser edge (w2s036–w2s043). Contracts: the web
// README paint-scheduling and accessibility-bound sections, and
// HOST-WIRE-CONTRACT.md (WebHost connection lifecycle, delivery repair uplink,
// inbound/outbound budgets).
import { expect, test } from "@playwright/test";
import { duplicateAccessibilityFrames } from "../test-support/DuplicateAccessibilityFrames.ts";
import type {} from "./w2-adversarial.fixture.ts";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.addScriptTag({ url: "/w2-adversarial.js", type: "module" });
  await page.waitForFunction(() => !!window.__w2);
});
test.afterEach(async ({ page }) => {
  await page
    .evaluate(() => {
      window.__w2?.disposeAll();
      window.__w2socket?.disposeAll();
    })
    .catch(() => {});
});

test("a frame burst within one animation frame coalesces to a single paint (w2s029)", async ({
  page,
}) => {
  const stats = await page.evaluate(async () => {
    const id = await window.__w2.create({
      renderer: "canvas",
      mountWidth: 480,
      mountHeight: 240,
    });
    const metrics = window.__w2.cellMetrics(id)!;
    const frame = (glyph: string) => ({
      width: metrics.columns,
      height: metrics.rows,
      styles: [null],
      rows: window.__w2.helpers.fullRows(metrics.columns, metrics.rows, glyph),
    });
    window.__w2.present(id, frame("."));
    await window.__w2.settle();
    const before = window.__w2.paintStatistics(id);
    for (let i = 0; i < 15; i += 1)
      window.__w2.present(id, frame(String.fromCharCode(65 + i)));
    await window.__w2.settle();
    const after = window.__w2.paintStatistics(id);
    return {
      presented: after.presentedFrames - before.presentedFrames,
      paints: after.paints - before.paints,
      coalesced: after.coalescedFrames - before.coalescedFrames,
    };
  });
  expect(stats.presented).toBe(15);
  expect(stats.paints).toBeLessThan(15);
  expect(stats.coalesced).toBeGreaterThanOrEqual(13);
});

test("exceeding the pending-announcement bound stops the session visibly (w2s030)", async ({
  page,
}) => {
  const limited = await page.evaluate(async () => {
    const id = await window.__w2.create({ renderer: "canvas" });
    await window.__w2.settle();
    window.__w2.present(id, {
      width: 4,
      height: 1,
      styles: [null],
      rows: [[[0, "....", 4, 0]]],
      accessibilityAnnouncements: Array.from({ length: 1025 }, (_, i) => ({
        message: `announcement ${i}`,
        politeness: "polite",
      })),
    });
    await window.__w2.settle();
    return window.__w2.paintStatistics(id).resourceLimitExceeded;
  });
  // The scheduler stops the session rather than silently dropping assistive output.
  expect(limited).toBe(true);
});

test("the newest frame shows after a hidden interval, without stale pixels (w2s031)", async ({
  page,
}) => {
  const pixels = await page.evaluate(async () => {
    const id = await window.__w2.create({
      renderer: "canvas",
      mountWidth: 480,
      mountHeight: 240,
    });
    const metrics = window.__w2.cellMetrics(id)!;
    const frame = (fg: string) => ({
      width: metrics.columns,
      height: metrics.rows,
      styles: [null, { fg }],
      rows: window.__w2.helpers
        .fullRows(metrics.columns, metrics.rows, "W")
        .map((row) =>
          row.map(
            ([x, t, s]) => [x, t, s, 1] as [number, string, number, number],
          ),
        ),
    });
    window.__w2.present(id, frame("#ff0000"));
    await window.__w2.settle();
    const a = window.__w2.canvasPixel(id, 1, 0);
    window.__w2.setDocumentVisible(id, false);
    window.__w2.present(id, frame("#00ff00"));
    window.__w2.setDocumentVisible(id, true);
    await window.__w2.settle();
    const b = window.__w2.canvasPixel(id, 1, 0);
    return { a, b };
  });
  expect(pixels.a[0]).toBeGreaterThan(pixels.a[1]); // red dominant
  expect(pixels.b[1]).toBeGreaterThan(pixels.b[0]); // green dominant after resume
});

test("losing terminal focus hides the DOM focus layer (w2s032)", async ({
  page,
}) => {
  const hidden = await page.evaluate(async () => {
    const id = await window.__w2.create({ renderer: "dom" });
    window.__w2.presentAccessibility(id, [
      {
        id: "field",
        actionTarget: "field:1",
        role: "textField",
        label: "Field",
        rect: [0, 0, 10, 1],
        isFocused: true,
        cursorAnchor: [1, 0],
        actions: ["focus", "setValue"],
        value: { type: "text", value: "x" },
      },
    ]);
    await window.__w2.settle();
    const input = document.querySelector<HTMLElement>(
      '[data-accessibility-id="field"]',
    )!;
    input.focus();
    await window.__w2.settle();
    const layer = () =>
      document.querySelector<HTMLElement>(".webhost-scene__focus-layer");
    const whenFocused = !layer()?.hidden;
    input.blur();
    document.body.focus();
    await window.__w2.settle();
    const whenBlurred = !layer()?.hidden;
    return { whenFocused, whenBlurred };
  });
  expect(hidden.whenFocused).toBe(true);
  expect(hidden.whenBlurred).toBe(false);
});

test("scene re-show repaints the retained frame without errors (w2s033)", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const id = await window.__w2.create({
      renderer: "canvas",
      mountWidth: 480,
      mountHeight: 240,
    });
    const metrics = window.__w2.cellMetrics(id)!;
    window.__w2.present(id, {
      width: metrics.columns,
      height: metrics.rows,
      styles: [null, { fg: "#00ff00" }],
      rows: window.__w2.helpers
        .fullRows(metrics.columns, metrics.rows, "W")
        .map((row) =>
          row.map(
            ([x, t, s]) => [x, t, s, 1] as [number, string, number, number],
          ),
        ),
    });
    await window.__w2.settle();
    window.__w2.setVisible(id, false);
    window.__w2.setVisible(id, true);
    await window.__w2.settle();
    return { pixel: window.__w2.canvasPixel(id, 1, 0) };
  });
  expect(result.pixel[1]).toBeGreaterThan(result.pixel[0]);
});

test("repeated visibility toggles neither crash nor emit input (w2s034)", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const errors: string[] = [];
    window.addEventListener("error", (event) => errors.push(event.message));
    const id = await window.__w2.create({ renderer: "canvas" });
    await window.__w2.settle();
    const before = window.__w2.inputs(id).length;
    for (let i = 0; i < 6; i += 1) {
      window.__w2.setDocumentVisible(id, false);
      window.__w2.setDocumentVisible(id, true);
    }
    await window.__w2.settle();
    return { errors, added: window.__w2.inputs(id).length - before };
  });
  expect(result.errors).toEqual([]);
  expect(result.added).toBe(0);
});

test("visibility changes do not steal focus from another element (w2s035)", async ({
  page,
}) => {
  const active = await page.evaluate(async () => {
    const external = document.createElement("input");
    external.id = "external";
    document.body.append(external);
    external.focus();
    const id = await window.__w2.create({ renderer: "canvas" });
    window.__w2.setDocumentVisible(id, false);
    window.__w2.setVisible(id, true);
    window.__w2.setDocumentVisible(id, true);
    await window.__w2.settle();
    return document.activeElement?.id;
  });
  expect(active).toBe("external");
});

// ---- Reconnect / backlog ----------------------------------------------------

test("an abnormal socket close reconnects and replays the handshake in order (w2s036)", async ({
  page,
}) => {
  await page.evaluate(() => {
    const id = window.__w2socket.create({ instantReconnect: true });
    window.__w2socket.openLatest(id);
    window.__w2socket.resize(id, 40, 12); // records lastResizeMessage for replay
    window.__w2socket.serverClose(id, 1006); // abnormal
    (window as unknown as { __sid: number }).__sid = id;
  });
  await page
    .waitForFunction(
      () =>
        window.__w2socket.socketCount(
          (window as unknown as { __sid: number }).__sid,
        ) === 2,
    )
    .catch(() => {});
  const replay = await page.evaluate(() => {
    const id = (window as unknown as { __sid: number }).__sid;
    window.__w2socket.openLatest(id);
    return window.__w2socket.sentBy(id, 1);
  });
  expect(replay.length).toBeGreaterThanOrEqual(2);
  expect(replay[0]).toContain("caps:");
  expect(replay.some((r) => r.startsWith("\u001eresize:"))).toBe(true);
});

test("a normal socket close does not reconnect (w2s037)", async ({ page }) => {
  const count = await page.evaluate(async () => {
    const id = window.__w2socket.create();
    window.__w2socket.openLatest(id);
    window.__w2socket.serverClose(id, 1000);
    await window.__w2socket.drainMicrotasks();
    return window.__w2socket.socketCount(id);
  });
  expect(count).toBe(1);
});

test("the receive backlog closes the socket with 1009 (w2s038)", async ({
  page,
}) => {
  const closed = await page.evaluate(() => {
    const id = window.__w2socket.create();
    window.__w2socket.openLatest(id);
    for (let i = 0; i < 33; i += 1) window.__w2socket.message(id, "ping");
    return window.__w2socket.closedWith(id, 0);
  });
  expect(closed?.code).toBe(1009);
});

test("an oversized message is dropped and requests a keyframe (w2s039)", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const id = window.__w2socket.create();
    window.__w2socket.openLatest(id);
    window.__w2socket.message(id, "a".repeat(8 * 1024 * 1024 + 512 * 1024));
    await window.__w2socket.drainMicrotasks();
    return {
      sent: window.__w2socket.sentByLatest(id),
      surfaces: window.__w2socket
        .records(id)
        .filter((r) => r.type === "surface").length,
    };
  });
  expect(
    result.sent.some((r) => r.includes('resync:{"scope":"keyframe"}')),
  ).toBe(true);
  expect(result.surfaces).toBe(0);
});

test("a stale-baseline delta is refused and requests a keyframe (w2s040)", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const id = window.__w2socket.create();
    window.__w2socket.openLatest(id);
    window.__w2socket.message(id, window.__w2socket.surfaceFrame(1, 1, "AB"));
    await window.__w2socket.drainMicrotasks();
    window.__w2socket.message(id, window.__w2socket.deltaFrame(1, 5, 9, "CD"));
    await window.__w2socket.drainMicrotasks();
    return {
      sent: window.__w2socket.sentByLatest(id),
      surfaces: window.__w2socket
        .records(id)
        .filter((r) => r.type === "surface").length,
    };
  });
  expect(
    result.sent.some((r) => r.includes('resync:{"scope":"keyframe"}')),
  ).toBe(true);
  expect(result.surfaces).toBe(1);
});

test("a delta without a baseline is refused and requests a keyframe (w2s041)", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const id = window.__w2socket.create();
    window.__w2socket.openLatest(id);
    window.__w2socket.message(id, window.__w2socket.deltaFrame(1, 2, 1, "CD"));
    await window.__w2socket.drainMicrotasks();
    return {
      sent: window.__w2socket.sentByLatest(id),
      surfaces: window.__w2socket
        .records(id)
        .filter((r) => r.type === "surface").length,
    };
  });
  expect(
    result.sent.some((r) => r.includes('resync:{"scope":"keyframe"}')),
  ).toBe(true);
  expect(result.surfaces).toBe(0);
});

test("disconnected input past its bound stops the session (w2s042)", async ({
  page,
}) => {
  const errors = await page.evaluate(() => {
    const id = window.__w2socket.create();
    for (let i = 0; i < 1100; i += 1)
      window.__w2socket.sendInput(id, "\u001ekey:character:a:0\n");
    return window.__w2socket.errors(id);
  });
  expect(errors.some((e) => e.includes("disconnected input exceeded"))).toBe(
    true,
  );
});

test("a dropped oversized message preserves the retained baseline (w2s043)", async ({
  page,
}) => {
  const surfaces = await page.evaluate(async () => {
    const id = window.__w2socket.create();
    window.__w2socket.openLatest(id);
    window.__w2socket.message(id, window.__w2socket.surfaceFrame(1, 1, "AB"));
    await window.__w2socket.drainMicrotasks();
    window.__w2socket.message(id, "a".repeat(8 * 1024 * 1024 + 512 * 1024));
    await window.__w2socket.drainMicrotasks();
    window.__w2socket.message(id, window.__w2socket.deltaFrame(1, 2, 1, "CD"));
    await window.__w2socket.drainMicrotasks();
    return window.__w2socket.records(id).filter((r) => r.type === "surface")
      .length;
  });
  // The full baseline survives the dropped oversized message, so the following
  // delta that names it still materializes.
  expect(surfaces).toBe(2);
});

// Wave 4 repair scenarios for STUI-1259 (w4web-a01 to a04, a06). Real 0.19.5
// records (test-support/DuplicateAccessibilityFrames.ts) carry two buttons
// with one occurrence-free id and distinct action targets. Each keeps its own
// element and DOM id, runtime and assistive focus name exactly that element,
// and hiding the first leaves the second's element in place (STUI-1288's
// rule: a duplicate's identity does not depend on its siblings).
test("duplicate accessibility siblings from real frames keep their own elements and focus (w4web-a01)", async ({
  page,
}) => {
  const frames = duplicateAccessibilityFrames();
  const record = (label: string) => {
    const frame = frames.get(`buttons: ${label}`);
    if (!frame) throw new Error(`missing recorded frame ${label}`);
    return frame;
  };
  // The tab-2 frame (the second focused) with an assistive request for the
  // first's target, as the session's next generation.
  const tab2 = JSON.parse(
    record("tab 2 focuses the second Same").slice("\u001esurface:".length),
  );
  const assistive = `\u001esurface:${JSON.stringify({
    ...tab2,
    gen: tab2.gen + 1,
    sequence: tab2.sequence + 1,
    accessibilityFocusRequest: {
      generation: "1",
      target: tab2.accessibilityTree[3].actionTarget,
    },
  })}\n`;
  const result = await page.evaluate(
    async (steps) => {
      const id = await window.__w2.create({
        renderer: "canvas",
        columns: 30,
        rows: 8,
        synchronizeAccessibilityFocus: true,
      });
      const sameID = 'App/buttons/Layout[0]/VStack[1]/ID["Same"]';
      const same = () =>
        [
          ...document.querySelectorAll<HTMLElement>("[data-accessibility-id]"),
        ].filter((element) => element.dataset.accessibilityId === sameID);
      const present = async (step: string) => {
        window.__w2.presentRaw(id, step);
        await window.__w2.settle();
        const elements = same();
        return {
          count: elements.length,
          distinctIDs: new Set(elements.map((element) => element.id)).size,
          focused: elements.map(
            (element) => document.activeElement === element,
          ),
        };
      };
      const tab1 = await present(steps.tab1);
      const original = same();
      for (const element of original) element.click();
      const activations = window.__w2
        .inputs(id)
        .filter((input) => input.includes(":activate"))
        .map((input) => decodeURIComponent(input.split(":")[2] ?? ""));
      const tab2 = await present(steps.tab2);
      const reused = same().every(
        (element, index) => element === original[index],
      );
      const assistive = await present(steps.assistive);
      const secondID = original[1]?.id;
      const hidden = await present(steps.hidden);
      const kept = same()[0] === original[1] && same()[0]?.id === secondID;
      return { tab1, activations, tab2, reused, assistive, hidden, kept };
    },
    {
      tab1: record("tab 1 focuses the first Same"),
      tab2: record("tab 2 focuses the second Same"),
      assistive,
      hidden: record("return hides the first Same"),
    },
  );
  expect(result).toEqual({
    tab1: { count: 2, distinctIDs: 2, focused: [true, false] },
    activations: [
      '12:App/buttons/Layout[0]/VStack[1]/ID["Same"]#2',
      '20:App/buttons/Layout[0]/VStack[1]/ID["Same"#1]#3',
    ],
    tab2: { count: 2, distinctIDs: 2, focused: [false, true] },
    reused: true,
    assistive: { count: 2, distinctIDs: 2, focused: [true, false] },
    hidden: { count: 1, distinctIDs: 1, focused: [false] },
    kept: true,
  });
});

test("duplicate static text siblings from a real frame keep two reading elements (w4web-a05)", async ({
  page,
}) => {
  const frame = duplicateAccessibilityFrames().get("text: initial");
  if (!frame) throw new Error("missing recorded frame text: initial");
  const result = await page.evaluate(async (frame) => {
    const id = await window.__w2.create({
      renderer: "canvas",
      columns: 30,
      rows: 8,
    });
    window.__w2.presentRaw(id, frame);
    await window.__w2.settle();
    const elements = [
      ...document.querySelectorAll<HTMLElement>("[data-accessibility-id]"),
    ].filter(
      (element) =>
        element.dataset.accessibilityId ===
        'App/text/Layout[0]/VStack[0]/ID["Same"]',
    );
    return {
      text: elements.map((element) => element.textContent),
      distinctIDs: new Set(elements.map((element) => element.id)).size,
    };
  }, frame);
  expect(result).toEqual({ text: ["Same", "Same"], distinctIDs: 2 });
});
