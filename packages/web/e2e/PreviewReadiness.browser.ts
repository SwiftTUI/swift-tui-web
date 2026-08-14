import { expect, type Page, type TestInfo, test } from "@playwright/test";

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
  focusPresentation?: {
    focusedIdentity?: string;
    semantics: string;
    prefersTextInput: boolean;
    hasFocusedRegion: boolean;
  };
  wasiEnvironment: Record<string, string>;
}

test("public browser/WASI runtime completes the preview-readiness journey", async ({
  page,
}, testInfo) => {
  const browserErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      browserErrors.push(message.text());
    }
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));

  await page.goto("/");
  await expect.poll(async () => (await snapshot(page)).ready).toBe(true);

  const initial = await snapshot(page);
  expect(initial.wasiEnvironment.SWIFTTUI_TRANSPORT).toBe("surface");
  expect(initial.wasiEnvironment.SWIFTTUI_MODE).toBe("browser");
  expect(initial.focusPresentation).toEqual({
    focusedIdentity: "root/editor",
    semantics: "edit",
    prefersTextInput: true,
    hasFocusedRegion: true,
  });
  expect(initial.accessibilityOrder).toEqual([
    "root",
    "root/tabs",
    "root/tabs/alpha",
    "root/tabs/beta",
    "root/panel-alpha",
    "root/editor",
    "root/status",
    "root/image",
  ]);
  expect(initial.activeAccessibilityID).toBe("root/editor");
  await expect(
    page.locator('[data-accessibility-id="root/tabs"]'),
  ).toHaveAttribute("role", "tablist");
  await expect(
    page.locator('[data-accessibility-id="root/tabs/alpha"]'),
  ).toHaveAttribute("aria-label", "Alpha tab, selected");
  await expect(
    page.locator('[data-accessibility-id="root/editor"]'),
  ).toHaveAttribute("role", "textbox");
  await expect(
    page.locator('[data-accessibility-id="root/image"]'),
  ).toHaveAttribute("role", "img");
  await expect(page.locator('[aria-label="Inactive tab content"]')).toHaveCount(
    0,
  );

  await expect
    .poll(async () => brightness((await snapshot(page)).imagePixel))
    .toBeGreaterThan(40);
  const lowOpacityBrightness = brightness((await snapshot(page)).imagePixel);

  await focusTerminal(page);
  await page.keyboard.press("x");
  await expect
    .poll(async () => (await snapshot(page)).counters)
    .toEqual([1, 0]);
  await expect(
    page.locator(".webhost-scene__accessibility-announcer"),
  ).toContainText("Alpha count 1");

  const betaTabPoint = await cellPoint(page, 12, 0.5);
  await page.mouse.click(betaTabPoint.x, betaTabPoint.y);
  await expect.poll(async () => (await snapshot(page)).activeTab).toBe("beta");
  await expect
    .poll(async () => {
      const records = (await snapshot(page)).inputRecords;
      return records.filter((record) => record.startsWith("\u001emouse:down:"))
        .length;
    })
    .toBeGreaterThan(0);

  await focusTerminal(page);
  await page.keyboard.press("x");
  await expect
    .poll(async () => (await snapshot(page)).counters)
    .toEqual([1, 1]);
  await focusTerminal(page);
  await page.keyboard.press("ArrowLeft");
  await expect.poll(async () => (await snapshot(page)).activeTab).toBe("alpha");
  expect((await snapshot(page)).counters).toEqual([1, 1]);
  await focusTerminal(page);
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await snapshot(page)).activeTab).toBe("beta");
  expect((await snapshot(page)).counters).toEqual([1, 1]);

  await focusTerminal(page);
  await page.keyboard.press("o");
  await expect.poll(async () => (await snapshot(page)).imageOpacity).toBe(0.75);
  await expect
    .poll(async () => (await snapshot(page)).lastFrameHadImagePayload)
    .toBe(false);
  await expect
    .poll(async () => brightness((await snapshot(page)).imagePixel))
    .toBeGreaterThan(lowOpacityBrightness + 60);

  const beforeResize = (await snapshot(page)).resizeRecords.at(-1);
  await page.evaluate(() => {
    (
      window as Window & {
        __swiftTUIPreviewJourney: { resizeMount(width: number): void };
      }
    ).__swiftTUIPreviewJourney.resizeMount(520);
  });
  await expect
    .poll(async () => (await snapshot(page)).resizeRecords.length)
    .toBeGreaterThan(initial.resizeRecords.length);
  const afterResize = (await snapshot(page)).resizeRecords.at(-1);
  expect(afterResize?.columns).toBeLessThan(
    beforeResize?.columns ?? Number.MAX_SAFE_INTEGER,
  );

  await page.evaluate(() => window.scrollTo(0, 0));
  const scrollPoint = await cellPoint(page, 5, 9);
  await page.mouse.move(scrollPoint.x, scrollPoint.y);
  await page.mouse.wheel(0, 120);
  await expect.poll(async () => (await snapshot(page)).scrollOffsetY).toBe(34);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  const capturedScrollRecords = (await snapshot(page)).inputRecords.filter(
    (record) => record.startsWith("\u001emouse:scrolled:"),
  ).length;

  await page.mouse.wheel(0, 120);
  await expect
    .poll(async () => page.evaluate(() => window.scrollY))
    .toBeGreaterThan(0);
  const exhaustedScrollRecords = (await snapshot(page)).inputRecords.filter(
    (record) => record.startsWith("\u001emouse:scrolled:"),
  ).length;
  expect(exhaustedScrollRecords).toBe(capturedScrollRecords);

  await page.evaluate(() => window.scrollTo(0, 0));
  const finalSnapshot = await snapshot(page);
  await attachEvidence(page, testInfo, finalSnapshot);
  expect(browserErrors).toEqual([]);
});

async function snapshot(page: Page): Promise<JourneySnapshot> {
  return await page.evaluate(() => {
    return (
      window as Window & {
        __swiftTUIPreviewJourney: { snapshot(): JourneySnapshot };
      }
    ).__swiftTUIPreviewJourney.snapshot();
  });
}

async function focusTerminal(page: Page): Promise<void> {
  await page.locator(".webhost-scene__terminal").focus();
}

async function cellPoint(
  page: Page,
  cellX: number,
  cellY: number,
): Promise<{ x: number; y: number }> {
  const state = await snapshot(page);
  const resize = state.resizeRecords.at(-1);
  const box = await page.locator("canvas.webhost-scene__surface").boundingBox();
  if (!box || !resize?.cellWidth || !resize.cellHeight) {
    throw new Error(
      "The browser journey did not publish canvas cell geometry.",
    );
  }
  return {
    x: box.x + cellX * resize.cellWidth,
    y: box.y + cellY * resize.cellHeight,
  };
}

function brightness(pixel: [number, number, number, number]): number {
  return pixel[0] + pixel[1] + pixel[2];
}

async function attachEvidence(
  page: Page,
  testInfo: TestInfo,
  state: JourneySnapshot,
): Promise<void> {
  await testInfo.attach("preview-readiness-state", {
    body: Buffer.from(`${JSON.stringify(state, null, 2)}\n`),
    contentType: "application/json",
  });
  await testInfo.attach("preview-readiness-final", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
}
