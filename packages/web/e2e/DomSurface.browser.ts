import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import type {} from "./dom-surface.fixture.ts";

test.beforeEach(async ({ page }) => {
  await page.goto("/health");
  await page.addScriptTag({ url: "/dom-surface.js", type: "module" });
  await page.waitForFunction(() => !!window.domJourney);
});

test("native find sees one live text occurrence and print preserves the committed grid", async ({
  page,
}) => {
  const found = await page.evaluate(() => {
    const find = (
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
    const first = find("Select me", true, false, false);
    const text = document.getSelection()?.toString();
    const second = find("Select me", true, false, false);
    return { first, text, second };
  });
  expect(found).toEqual({ first: true, text: "Select me", second: false });
  await page.addStyleTag({ url: "/style.css" });
  const cells = page.locator(".webhost-scene__surface-row").first();
  const before = await cells.boundingBox();
  await page.emulateMedia({ media: "print" });
  expect(await cells.boundingBox()).toEqual(before);
  expect(await cells.textContent()).toContain("Select me");
});

test("multiline sparse Unicode copies exactly with row breaks and boundary spaces", async ({
  page,
  browserName,
}) => {
  const result = await page.evaluate(() => window.domJourney.copyCorpus());
  const expected = "  A🙂  éB   \n<script>  漢";
  expect(result.text).toBe(expected);
  expect(result.scripts).toBe(0);
  if (process.platform === "darwin" && browserName === "webkit")
    execFileSync("/usr/bin/pbcopy", { input: "clipboard fixture sentinel" });
  if (browserName === "webkit" && process.platform === "linux")
    expect(await page.evaluate(() => document.execCommand("copy"))).toBe(true);
  else
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+c" : "Control+c",
    );
  // The macOS clipboard retains the original code points. macOS WebKit
  // normalizes them when exposing a native paste back to a page; test that separate
  // browser boundary without mistaking it for corruption during copy.
  if (process.platform === "darwin" && browserName === "webkit")
    await expect
      .poll(() => execFileSync("/usr/bin/pbpaste", { encoding: "utf8" }))
      .toBe(expected);
  await page.evaluate(() => {
    const box = document.createElement("textarea");
    box.id = "sparse-copy-target";
    box.addEventListener(
      "paste",
      (event) =>
        (box.dataset.clipboard =
          event.clipboardData?.getData("text/plain") ?? ""),
    );
    document.body.append(box);
    box.focus();
  });
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+v" : "Control+v",
  );
  await expect(page.locator("#sparse-copy-target")).toHaveAttribute(
    "data-clipboard",
    browserName === "webkit" && process.platform === "darwin"
      ? expected.normalize("NFC")
      : expected,
  );
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
    // A legacy multi-character tuple retains its natural shaping. The wire
    // span, rather than stretched font advances, determines the cell box.
    expect(g.textWidth).toBeLessThanOrEqual(g.runWidth + 1);
    expect(g.image.naturalWidth).toBe(1);
    expect(g.image.width).toBeCloseTo(g.cells[0]!.width * 2, 1);
    expect(g.image.clipWidth).toBeCloseTo(g.cells[0]!.width * 1.5, 1);
    expect(g.image.opacity).toBe("0.5");
    expect(g.cells[1]!.x - g.cells[0]!.x).toBeCloseTo(g.cells[0]!.width, 1);
    expect(g.cells[2]!.x - g.cells[1]!.x).toBeCloseTo(g.cells[1]!.width, 1);
  }
});

for (const dpr of [1, 1.25, 1.5, 2, 3]) {
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
  await page.evaluate(() => window.domJourney.select(2));
  expect(await page.evaluate(() => window.domJourney.state().selected)).toBe(
    "counter",
  );
  await page.evaluate(() => window.domJourney.update("remove-leading"));
  expect(await page.evaluate(() => window.domJourney.state().selected)).toBe(
    "counter",
  );
});

test("unrelated row damage leaves retained text and link rows untouched", async ({
  page,
}) => {
  const mutations = await page.evaluate(async () => {
    const rows = document.querySelectorAll(".webhost-scene__surface-row");
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((changes) =>
      records.push(...changes),
    );
    for (const index of [0, 2])
      observer.observe(rows[index]!, {
        subtree: true,
        attributes: true,
        childList: true,
        characterData: true,
      });
    await window.domJourney.update("other-row");
    await window.domJourney.update("unchanged");
    records.push(...observer.takeRecords());
    observer.disconnect();
    return records.map((record) => record.type);
  });
  expect(mutations).toEqual([]);
});

test("global element rules cannot change cell, link or image box allocation", async ({
  page,
}) => {
  const before = await page.evaluate(() => window.domJourney.geometry());
  await page.addStyleTag({
    content: `
    div, span, a, img { box-sizing:content-box; padding:18px; margin:9px;
      border:2px solid; font:30px/3 serif; letter-spacing:3px;
      text-align:right; text-indent:12px; text-transform:uppercase; }
  `,
  });
  const after = await page.evaluate(() => window.domJourney.geometry());
  expect(after.cells.map((cell) => cell.width)).toEqual(
    before.cells.map((cell) => cell.width),
  );
  expect(after.cells.map((cell) => cell.height)).toEqual(
    before.cells.map((cell) => cell.height),
  );
  expect(after.image.width).toBe(before.image.width);
  expect(after.image.clipWidth).toBe(before.image.clipWidth);
  const styles = await page
    .locator(
      ".webhost-scene__surface-row > *, .webhost-scene__surface-image, .webhost-scene__surface-image img",
    )
    .evaluateAll((elements) =>
      elements.map((element) => {
        const style = getComputedStyle(element);
        return {
          padding: style.padding,
          margin: [
            style.marginTop,
            style.marginRight,
            style.marginBottom,
            style.marginLeft,
          ],
          expectedEndMargin: element.parentElement?.classList.contains(
            "webhost-scene__surface-row",
          )
            ? `${-Number.parseFloat(style.width)}px`
            : "0px",
          border: style.borderWidth,
          sizing: style.boxSizing,
        };
      }),
    );
  for (const style of styles)
    expect(style).toEqual({
      padding: "0px",
      margin: ["0px", style.expectedEndMargin, "0px", "0px"],
      expectedEndMargin: style.expectedEndMargin,
      border: "0px",
      sizing: "border-box",
    });
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
