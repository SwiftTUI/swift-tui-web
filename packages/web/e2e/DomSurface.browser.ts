import { expect, test } from "@playwright/test";
import type {} from "./dom-surface.fixture.ts";

test.beforeEach(async ({ page }) => {
  await page.goto("/health");
  await page.addScriptTag({ url: "/dom-surface.js", type: "module" });
  await page.waitForFunction(() => !!window.domJourney);
});

test("selection and copy survive other-row, same-row, cosmetic, font and resize paints", async ({
  page,
  browserName,
}) => {
  await page.locator(".webhost-scene__terminal").focus();
  await page.evaluate(() => window.domJourney.select());
  for (const kind of ["other-row", "same-row", "cosmetic"]) {
    await page.evaluate((kind) => window.domJourney.update(kind), kind);
    expect(await page.evaluate(() => window.domJourney.state())).toMatchObject({
      selected: "Select me",
      sameNode: true,
    });
  }
  await page.evaluate(() => window.domJourney.restyle());
  await page.evaluate(() => window.domJourney.resize(1.25));
  expect(await page.evaluate(() => window.domJourney.state())).toMatchObject({
    selected: "Select me",
    sameNode: true,
  });
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+c" : "Control+c",
  );
  expect(
    await page.evaluate(() => window.domJourney.state().copyShortcutPrevented),
  ).toBe(false);
  if (browserName === "webkit" && process.platform === "linux") {
    // Linux WebKit does not dispatch copy for a non-editable Range shortcut,
    // even on a plain page. Invoke its native copy command; keep the shortcut
    // pass-through assertion above and the actual clipboard paste below.
    expect(await page.evaluate(() => document.execCommand("copy"))).toBe(true);
  }
  await expect
    .poll(() => page.evaluate(() => window.domJourney.state().copied))
    .toBe("Select me");
  // Real browser clipboard round trip: paste into a native editable control.
  await page.evaluate(() => {
    const box = document.createElement("textarea");
    box.id = "copy-target";
    document.body.append(box);
    box.focus();
  });
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+v" : "Control+v",
  );
  await expect(page.locator("#copy-target")).toHaveValue("Select me");
});

for (const kind of ["selected", "removed", "shrink"]) {
  test(`changing selected content (${kind}) cancels selection and publishes immediately`, async ({
    page,
  }) => {
    await page.evaluate(() => window.domJourney.select());
    await page.evaluate((kind) => window.domJourney.update(kind), kind);
    expect(await page.evaluate(() => window.domJourney.state().selected)).toBe(
      "",
    );
    if (kind === "selected")
      expect(
        await page.evaluate(() => window.domJourney.state().text),
      ).toContain("REPLACED!");
  });
}

test("an Alt drag survives arriving frames without application pointer capture", async ({
  page,
}) => {
  const cell = page
    .locator(".webhost-scene__surface-row")
    .first()
    .locator("span")
    .first();
  const box = (await cell.boundingBox())!;
  await page.keyboard.down("Alt");
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, {
    steps: 8,
  });
  const selected = await page.evaluate(
    () => window.domJourney.state().selected,
  );
  expect(selected).toBeTruthy();
  await page.evaluate(() => window.domJourney.update("same-row"));
  await page.evaluate(() => window.domJourney.update("cosmetic"));
  await page.keyboard.up("Alt");
  await page.mouse.up();
  expect(await page.evaluate(() => window.domJourney.state().selected)).toBe(
    selected,
  );
  expect(
    (await page.evaluate(() => window.domJourney.state().inputs)).filter((x) =>
      x.includes("mouse:"),
    ),
  ).toEqual([]);
});

test("native anchors activate once and measured grid stays aligned through CSS zoom", async ({
  page,
}) => {
  await page.waitForFunction(
    () =>
      document.querySelector(".webhost-scene__surface-images img") instanceof
        HTMLImageElement &&
      (
        document.querySelector(
          ".webhost-scene__surface-images img",
        ) as HTMLImageElement
      ).naturalWidth === 1,
  );
  const link = page.locator("a[data-surface-link]");
  await expect(link).toHaveAttribute("href", "https://example.com/swifttui");
  await link.click();
  expect(await page.evaluate(() => window.domJourney.state().opened)).toEqual([
    "https://example.com/swifttui",
  ]);
  for (const zoom of [1, 1.25, 2]) {
    await page.evaluate((zoom) => window.domJourney.resize(zoom), zoom);
    const g = await page.evaluate(() => window.domJourney.geometry());
    expect(Math.abs(g.textWidth - g.runWidth)).toBeLessThan(2);
    expect(g.image.naturalWidth).toBe(1);
    expect(g.image.width).toBeCloseTo(g.cells[0]!.width * 2, 1);
    expect(g.image.clipWidth).toBeCloseTo(g.cells[0]!.width * 1.5, 1);
    expect(g.image.opacity).toBe("0.5");
    expect(g.cells[1]!.x - g.cells[0]!.x).toBeCloseTo(g.cells[0]!.width, 1);
    expect(g.cells[2]!.x - g.cells[1]!.x).toBeCloseTo(g.cells[1]!.width, 1);
  }
});

for (const dpr of [1, 2]) {
  test.describe(`glyphs at DPR ${dpr}`, () => {
    test.use({ deviceScaleFactor: dpr });
    for (const size of [
      [8, 18],
      [13, 27],
    ]) {
      test(`SVG glyph geometry agrees with Canvas at ${size.join("x")}`, async ({
        page,
      }, info) => {
        const result = await page.evaluate(
          ([w, h]) => window.domJourney.glyphs(w!, h!),
          size,
        );
        expect(result.text).toBe("┌─┬━┓│╋╬╰╱█▚⠁⠿⣿");
        expect(result.count).toBe(15);
        expect(result.total).toBeGreaterThan(100);
        expect(result.different / result.total).toBeLessThan(0.15);
        await info.attach("dom-canvas-glyphs", {
          body: await page.screenshot(),
          contentType: "image/png",
        });
        await info.attach("glyph-comparison", {
          body: JSON.stringify(result),
          contentType: "application/json",
        });
      });
    }
  });
}

test("removing a preceding run keeps the selected node in place", async ({
  page,
}) => {
  await page.evaluate(() => window.domJourney.select(1));
  expect(await page.evaluate(() => window.domJourney.state().selected)).toBe(
    "counter",
  );
  await page.evaluate(() => window.domJourney.update("remove-leading"));
  expect(await page.evaluate(() => window.domJourney.state().selected)).toBe(
    "counter",
  );
});

test("pointer coordinates use the zoomed DOM grid", async ({ page }) => {
  for (const zoom of [1, 1.25, 2]) {
    await page.evaluate((zoom) => window.domJourney.resize(zoom), zoom);
    const geometry = await page.evaluate(() => window.domJourney.geometry());
    const cell = geometry.cells[1]!;
    await page.mouse.click(cell.x + cell.width / 2, cell.y + cell.height / 2);
    const messages = await page.evaluate(
      () => window.domJourney.state().inputs,
    );
    const down = messages
      .filter((message) => message.includes("mouse:down:"))
      .at(-1);
    expect(down).toBeDefined();
    const fields = down!.trim().split(":");
    expect(Number(fields[2])).toBeCloseTo(3, 1);
    expect(Number(fields[3])).toBeCloseTo(2.5, 1);
  }
});

test("native navigation enforces URL policy and custom hooks run once", async ({
  page,
}) => {
  await page
    .context()
    .route("https://example.test/**", (route) =>
      route.fulfill({ body: "native anchor target" }),
    );
  await page.evaluate(() => window.domJourney.linkPolicies());
  await expect(page.locator("#policy-links a")).toHaveCount(1);
  await expect(page.locator("#policy-links a")).toHaveAttribute(
    "rel",
    "noopener noreferrer",
  );
  const popupPromise = page.waitForEvent("popup");
  await page.locator("#policy-links a").click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  expect(popup.url()).toBe("https://example.test/target");
  await popup.close();
  await expect(page.locator("#hook-links a").first()).toHaveAttribute(
    "href",
    "#",
  );
  await page.locator("#hook-links a").first().click();
  expect(await page.evaluate(() => window.domJourney.state().opened)).toEqual([
    "app:document/7",
  ]);
});
