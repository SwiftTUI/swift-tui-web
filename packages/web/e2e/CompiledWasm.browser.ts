import { expect, type Page, test } from "@playwright/test";
import type {} from "./compiled-wasm.fixture.ts";

test.afterEach(async ({ page }, testInfo) => {
  const state = await page
    .evaluate(() => window.__compiledWasm?.snapshot())
    .catch(() => undefined);
  if (state) {
    await testInfo.attach("compiled-wasm-state", {
      body: JSON.stringify(
        { browserVersion: page.context().browser()?.version(), ...state },
        null,
        2,
      ),
      contentType: "application/json",
    });
  }
});

test("engine capabilities for compiled Swift WASM", async ({
  page,
  browserName,
}, testInfo) => {
  await openFixture(page);
  const { capabilities } = await snapshot(page);
  expect(capabilities.engine).toBe(
    browserName === "webkit" && !capabilities.signals.errorHasJSCSourceURL
      ? "unknown"
      : { chromium: "v8", firefox: "gecko", webkit: "jsc" }[browserName],
  );
  expect(capabilities.stackLeanRecommended).toBe(browserName !== "chromium");
  expect(capabilities.crossOriginIsolated).toBe(true);
  expect(capabilities.sharedArrayBuffer).toBe(true);
  expect(capabilities.signals.wasmSuspendingType).toBe(
    capabilities.signals.wasmPromisingType,
  );
  testInfo.annotations.push({
    type: "JSPI",
    description: capabilities.supportsJSPI
      ? "supported: main-thread journey required"
      : "unsupported: main-thread journey explicitly skipped",
  });
});

for (const renderer of ["canvas", "dom"] as const) {
  for (const mode of ["worker", "main-thread"] as const) {
    test(`compiled Swift WASM ${renderer} ${mode}: input, scene retention and teardown`, async ({
      page,
    }, testInfo) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      let workersStarted = 0;
      let workersClosed = 0;
      page.on("worker", (worker) => {
        workersStarted += 1;
        worker.on("close", () => {
          workersClosed += 1;
        });
      });
      await openFixture(page);
      const { capabilities } = await snapshot(page);
      test.skip(
        mode === "main-thread" && !capabilities.supportsJSPI,
        `${testInfo.project.name} does not expose WebAssembly.Suspending and WebAssembly.promising`,
      );

      await page.evaluate(
        ({ mode, renderer }) =>
          window.__compiledWasm.start(mode, "alpha", undefined, renderer),
        { mode, renderer },
      );
      await expectCount(page, "alpha", 0);
      expect((await snapshot(page)).scenes).toEqual([
        "alpha",
        "animation",
        "images",
        "deep",
        "accessibility",
        "controls",
        "scrolling",
        "reading",
        "beta",
      ]);
      // Real browser key events -> WASI stdin -> Swift Button -> rendered frame.
      await page.locator(".webhost-scene__terminal:visible").focus();
      await page.keyboard.press("Tab");
      await page.keyboard.press("Enter");
      await expectCount(page, "alpha", 1);

      await page
        .getByRole("button", { name: "Beta scene", exact: true })
        .click();
      await expectCount(page, "beta", 0);
      await clickIncrement(page, "beta");
      await expectCount(page, "beta", 1);
      await page
        .getByRole("button", { name: "Alpha scene", exact: true })
        .click();
      await expect
        .poll(async () => (await snapshot(page)).selectedSceneId)
        .toBe("alpha");
      await expectCount(page, "alpha", 1);
      await clickIncrement(page, "alpha");
      await expectCount(page, "alpha", 2);
      await page
        .getByRole("button", { name: "Beta scene", exact: true })
        .click();
      await expect
        .poll(async () => (await snapshot(page)).selectedSceneId)
        .toBe("beta");
      await expectCount(page, "beta", 1);
      await clickIncrement(page, "beta");
      await expectCount(page, "beta", 2);

      expect((await snapshot(page)).createdScenes).toEqual(["alpha", "beta"]);
      expect(workersStarted).toBe(mode === "worker" ? 2 : 0);
      expect((await snapshot(page)).jspiStarts).toBe(
        mode === "main-thread" ? 2 : 0,
      );
      await page
        .getByRole("button", { name: "Dispose app", exact: true })
        .click();
      await expect.poll(async () => (await snapshot(page)).disposed).toBe(true);
      await expect(page.locator("#wasm-mount")).toBeEmpty();
      // Alpha is paused at disposal: its worker/promise must also terminate.
      await expect.poll(() => workersClosed).toBe(workersStarted);
      await expect
        .poll(async () => (await snapshot(page)).jspiSettled)
        .toBe(mode === "main-thread" ? 2 : 0);
      expect((await snapshot(page)).errors).toEqual([]);
      expect(errors).toEqual([]);
    });
  }
}

async function openFixture(page: Page): Promise<void> {
  await page.goto("/compiled-wasm.html");
  await page.waitForFunction(() => !!window.__compiledWasm);
}

async function snapshot(page: Page) {
  return page.evaluate(() => window.__compiledWasm.snapshot());
}

async function expectCount(
  page: Page,
  scene: string,
  count: number,
): Promise<void> {
  const name = scene === "alpha" ? "Alpha" : "Beta";
  await expect
    .poll(async () => {
      const frame = (await snapshot(page)).frames[scene];
      return frame?.rows
        .map((row) => row.map((cell) => cell[1]).join(""))
        .join("\n");
    })
    .toContain(`${name} count ${count}`);
  await expect(
    page.locator(
      `.webhost-scene:visible [aria-label="${name} count ${count}"]`,
    ),
  ).toHaveCount(1);
}

async function clickIncrement(page: Page, scene: string): Promise<void> {
  const label = `Increment ${scene === "alpha" ? "Alpha" : "Beta"}`;
  const button = page.locator(".webhost-scene:visible").getByRole("button", {
    name: label,
    exact: true,
  });
  await expect(button).toBeVisible();
  const box = await button.boundingBox();
  if (!box) throw new Error(`Missing compiled Swift button: ${label}`);
  // The first producer frame can precede the host's resize acknowledgement.
  // Its grid size need not fill the surface, so scaling by surface/frame size
  // can click another row. The semantic box uses the presenter's cell metrics.
  // Keep a real pointer click: this journey still exercises mouse ingress.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

const header = [0, 97, 115, 109, 1, 0, 0, 0];
for (const [name, bytes, code] of [
  ["empty", header, "missingExport"],
  [
    "missing memory",
    [
      ...header,
      1,
      4,
      1,
      0x60,
      0,
      0,
      3,
      2,
      1,
      0,
      7,
      10,
      1,
      6,
      ...Buffer.from("_start"),
      0,
      0,
      10,
      4,
      1,
      2,
      0,
      0x0b,
    ],
    "missingExport",
  ],
  [
    "missing start",
    [...header, 5, 3, 1, 0, 1, 7, 10, 1, 6, ...Buffer.from("memory"), 2, 0],
    "missingExport",
  ],
] as const) {
  for (const mode of ["worker", "main-thread"] as const) {
    test(`${name} WASM is diagnosed before first frame (${mode})`, async ({
      page,
    }) => {
      await page.route("**/invalid.wasm", (route) =>
        route.fulfill({
          body: Buffer.from(bytes),
          contentType: "application/wasm",
        }),
      );
      await openFixture(page);
      test.skip(
        mode === "main-thread" &&
          !(await snapshot(page)).capabilities.supportsJSPI,
        "Engine does not advertise JSPI",
      );
      await page.evaluate(
        ({ mode }) =>
          window.__compiledWasm.start(mode, "alpha", undefined, "canvas", {
            wasm: "/invalid.wasm",
          }),
        { mode },
      );
      await expect
        .poll(async () => (await snapshot(page)).errors.join("\n"))
        .toContain(`wasi.profile.${code}`);
      expect((await snapshot(page)).frames).toEqual({});
    });
  }
}

test("missing worker has an attributable startup failure", async ({ page }) => {
  await page.route("**/missing-worker.js", (route) =>
    route.fulfill({ status: 404 }),
  );
  await openFixture(page);
  await page.evaluate(() =>
    window.__compiledWasm.start("worker", "alpha", undefined, "canvas", {
      worker: "/missing-worker.js",
    }),
  );
  await expect
    .poll(async () => (await snapshot(page)).errors.join("\n"))
    .toContain("wasi.worker.startFailed");
  expect((await snapshot(page)).frames).toEqual({});
});

test("invalid execution mode is rejected", async ({ page }) => {
  await openFixture(page);
  const message = await page.evaluate(async () => {
    try {
      await window.__compiledWasm.start("invalid" as "worker");
      return "unexpected success";
    } catch (error) {
      return String(error);
    }
  });
  expect(message).toContain("wasi.profile.unsupportedMode");
  expect((await snapshot(page)).frames).toEqual({});
});

test("unsupported JSPI reports its missing requirement", async ({ page }) => {
  await openFixture(page);
  test.skip(
    (await snapshot(page)).capabilities.supportsJSPI,
    "This engine supports JSPI",
  );
  await page.evaluate(() => window.__compiledWasm.start("main-thread"));
  await expect
    .poll(async () => (await snapshot(page)).errors.join("\n"))
    .toContain("wasi.profile.requiresJSPI");
  expect((await snapshot(page)).frames).toEqual({});
});
