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

for (const mode of ["worker", "main-thread"] as const) {
  test(`compiled Swift WASM ${mode}: input, scene retention and teardown`, async ({
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
      (executionMode) => window.__compiledWasm.start(executionMode),
      mode,
    );
    await expectCount(page, "alpha", 0);
    expect((await snapshot(page)).scenes).toEqual([
      "alpha",
      "animation",
      "deep",
      "accessibility",
      "beta",
    ]);
    // Real browser key events -> WASI stdin -> Swift Button -> rendered frame.
    await page.locator(".webhost-scene__terminal:visible").focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expectCount(page, "alpha", 1);

    await page.getByRole("button", { name: "Beta scene", exact: true }).click();
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
    await page.getByRole("button", { name: "Beta scene", exact: true }).click();
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
  const point = await page.evaluate((id) => {
    const frame = window.__compiledWasm.snapshot().frames[id];
    if (!frame) throw new Error(`Missing compiled Swift frame: ${id}`);
    const label = `Increment ${id === "alpha" ? "Alpha" : "Beta"}`;
    const node = frame.accessibilityTree?.find((node) => node.label === label);
    const canvas = [
      ...document.querySelectorAll<HTMLCanvasElement>(
        "canvas.webhost-scene__surface",
      ),
    ].find((element) => element.getBoundingClientRect().width > 0);
    if (!node || !canvas)
      throw new Error(`Missing compiled Swift button: ${label}`);
    const box = canvas.getBoundingClientRect();
    return {
      x: box.x + ((node.rect[0] + node.rect[2] / 2) * box.width) / frame.width,
      y:
        box.y + ((node.rect[1] + node.rect[3] / 2) * box.height) / frame.height,
    };
  }, scene);
  await page.mouse.click(point.x, point.y);
}
