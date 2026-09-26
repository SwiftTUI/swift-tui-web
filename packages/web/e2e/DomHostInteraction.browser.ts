import { expect, test } from "@playwright/test";
import type {} from "./dom-surface.fixture.ts";

const modifier = process.platform === "darwin" ? "Meta" : "Control";
test.beforeEach(async ({ page }) => {
  await page.goto("/health");
  await page.addScriptTag({ url: "/dom-surface.js", type: "module" });
  await page.waitForFunction(() => !!window.domJourney);
});

test("plain text dragging copies without a mode and leaves controls available", async ({
  page,
  browserName,
}) => {
  await expect(page.locator(".webhost-scene__selection-controls")).toHaveCount(
    0,
  );
  const baseline = await page.evaluate(
    () => window.domJourney.state().inputs.length,
  );
  const box = await page
    .locator(".webhost-scene__surface-row")
    .first()
    .locator("span")
    .first()
    .evaluate((e) => {
      const range = document.createRange();
      range.selectNodeContents(e);
      const r = range.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, {
    steps: 6,
  });
  await page.mouse.up();
  expect(await page.evaluate(() => window.domJourney.state().selected)).toBe(
    "Select me",
  );
  await page.keyboard.press(`${modifier}+c`);
  if (browserName === "webkit" && process.platform === "linux")
    await page.evaluate(() => document.execCommand("copy"));
  expect(
    await page.evaluate(() => window.domJourney.state().copyShortcutPrevented),
  ).toBe(false);
  await expect
    .poll(() => page.evaluate(() => window.domJourney.state().copied))
    .toBe("Select me");
  expect(
    await page.evaluate(() => window.domJourney.state().inputs.length),
  ).toBe(baseline);
  // No mode to exit before activating a link or returning to app input.
  await page.locator("a[data-surface-link]").click();
  expect(await page.evaluate(() => window.domJourney.state().opened)).toEqual([
    "https://example.com/swifttui",
  ]);
  await page.locator(".webhost-scene__terminal").focus();
  await page.keyboard.press("ArrowRight");
  expect(
    await page.evaluate(() => window.domJourney.state().inputs.length),
  ).toBe(baseline + 1);
});

for (const alt of [false, true]) {
  test(`control drags remain app input with Alt=${alt}`, async ({ page }) => {
    await page.evaluate(() => window.domJourney.selectionControls());
    const control = page
      .locator(".webhost-scene__surface-row")
      .first()
      .locator('[data-text-selectable="false"]');
    await expect(control).toHaveText("Button");
    const box = await control.boundingBox();
    // display:contents spans use a Range for their hit rectangle.
    const rect =
      box ??
      (await control.evaluate((e) => {
        const range = document.createRange();
        range.selectNodeContents(e);
        const r = range.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }));
    if (alt) await page.keyboard.down("Alt");
    await page.mouse.move(rect.x + 1, rect.y + rect.height / 2);
    await page.mouse.down();
    await page.mouse.move(rect.x + rect.width - 1, rect.y + rect.height / 2, {
      steps: 5,
    });
    await page.mouse.up();
    if (alt) await page.keyboard.up("Alt");
    expect(await page.evaluate(() => window.domJourney.state().selected)).toBe(
      "",
    );
    const inputs = await page.evaluate(() =>
      window.domJourney.state().inputs.filter((s) => s.includes("mouse:")),
    );
    expect(inputs.some((s) => s.includes("mouse:down"))).toBe(true);
    expect(inputs.some((s) => s.includes("mouse:up"))).toBe(true);
  });
}

test("semantic boundaries split coalesced text and exclude controls from cross-boundary copy", async ({
  page,
}) => {
  await page.evaluate(() => window.domJourney.selectionControls());
  const row = page.locator(".webhost-scene__surface-row").first();
  await expect(row.locator('[data-text-selectable="true"]')).toHaveText([
    "Alpha",
    "Omega",
    " ".repeat(44),
  ]);
  const copied = await page.evaluate(() => {
    const row = document.querySelector(".webhost-scene__surface-row")!;
    const first = row.children[0]!.firstChild!;
    const last = row.children[2]!.firstChild!;
    document.getSelection()!.setBaseAndExtent(first, 0, last, 5);
    const event = new ClipboardEvent("copy", {
      clipboardData: new DataTransfer(),
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(event);
    return event.clipboardData?.getData("text/plain");
  });
  expect(copied).toBe("AlphaOmega");
  for (const y of [1, 2])
    await expect(
      page
        .locator(".webhost-scene__surface-row")
        .nth(y)
        .locator("span")
        .first(),
    ).toHaveAttribute("data-text-selectable", "true");
  for (const y of [3, 4, 5, 6])
    await expect(
      page
        .locator(".webhost-scene__surface-row")
        .nth(y)
        .locator("span")
        .first(),
    ).toHaveAttribute("data-text-selectable", "false");
  await page.evaluate(() => window.domJourney.selectionControls(false));
  await expect(row.locator('[data-text-selectable="false"]')).toHaveCount(0);
});

for (const y of [1, 2]) {
  test(`editable painted text in row ${y} yields drags but forwards collapsed field clicks`, async ({
    page,
  }) => {
    await page.evaluate(() => window.domJourney.selectionControls());
    const rect = await page
      .locator(".webhost-scene__surface-row")
      .nth(y)
      .locator("span")
      .first()
      .evaluate((e) => {
        const range = document.createRange();
        range.selectNodeContents(e);
        const r = range.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      });
    await page.mouse.move(rect.x + 1, rect.y + rect.height / 2);
    await page.mouse.down();
    await page.mouse.move(rect.x + rect.width - 1, rect.y + rect.height / 2, {
      steps: 5,
    });
    await page.mouse.up();
    expect(await page.evaluate(() => window.domJourney.state().selected)).toBe(
      y === 1 ? "Field text" : "Editor text",
    );
    expect(
      await page.evaluate(() =>
        window.domJourney.state().inputs.filter((s) => s.includes("mouse:")),
      ),
    ).toEqual([]);
    await page.mouse.click(rect.x + 2, rect.y + rect.height / 2);
    const inputs = await page.evaluate(() =>
      window.domJourney.state().inputs.filter((s) => s.includes("mouse:")),
    );
    expect(inputs.map((s) => s.split(":")[1])).toEqual(["down", "up"]);
  });
}

test("browser shortcuts and pinch-wheel events retain defaults without entering Swift input", async ({
  page,
}) => {
  const result = await page.evaluate(() => {
    const terminal = document.querySelector(".webhost-scene__terminal")!;
    const before = window.domJourney.state().inputs.length;
    const keys = [
      "f",
      "+",
      "=",
      "-",
      "0",
      "l",
      "r",
      "t",
      "w",
      "n",
      "Tab",
      "PageUp",
      "PageDown",
    ];
    const prevented = keys.flatMap((key) =>
      ["ctrlKey", "metaKey"].map((mod) => {
        const event = new KeyboardEvent("keydown", {
          key,
          [mod]: true,
          bubbles: true,
          cancelable: true,
        });
        terminal.dispatchEvent(event);
        return event.defaultPrevented;
      }),
    );
    for (const key of ["ArrowLeft", "ArrowRight"]) {
      const event = new KeyboardEvent("keydown", {
        key,
        altKey: true,
        bubbles: true,
        cancelable: true,
      });
      terminal.dispatchEvent(event);
      prevented.push(event.defaultPrevented);
    }
    const wheel = new WheelEvent("wheel", {
      ctrlKey: true,
      deltaY: 20,
      bubbles: true,
      cancelable: true,
    });
    terminal.dispatchEvent(wheel);
    prevented.push(wheel.defaultPrevented);
    return {
      prevented,
      inputs: window.domJourney.state().inputs.length - before,
    };
  });
  expect(result.prevented.every((x) => !x)).toBe(true);
  expect(result.inputs).toBe(0);
});

for (const button of ["left", "middle"] as const) {
  test(`modified ${button} web-link navigation bypasses the ordinary activation hook`, async ({
    page,
  }) => {
    await page
      .context()
      .route("https://example.com/**", (route) =>
        route.fulfill({ body: "Native link destination" }),
      );
    const popup = page.context().waitForEvent("page");
    await page
      .locator("a[data-surface-link]")
      .click({ button, modifiers: button === "left" ? [modifier] : [] });
    const target = await popup;
    await expect(target).toHaveURL("https://example.com/swifttui");
    expect(await page.evaluate(() => window.domJourney.state().opened)).toEqual(
      [],
    );
    await target.close();
  });
}

for (const ending of ["pointercancel", "lostpointercapture", "blur"] as const) {
  test(`captured pointer ${ending} cancels once and suppresses the stale release`, async ({
    page,
  }) => {
    const result = await page.evaluate((ending) => {
      const terminal = document.querySelector<HTMLElement>(
        ".webhost-scene__terminal",
      )!;
      const root = document.querySelector<HTMLElement>(
        ".webhost-scene__surface--dom",
      )!;
      const rect = root.getBoundingClientRect();
      const send = (type: string) =>
        terminal.dispatchEvent(
          new PointerEvent(type, {
            pointerId: 77,
            pointerType: "mouse",
            button: 0,
            buttons: type === "pointerup" ? 0 : 1,
            clientX: rect.left + 3,
            clientY: rect.top + rect.height - 3,
            bubbles: true,
            cancelable: true,
          }),
        );
      // Synthetic events cannot acquire native capture; exercise the same host
      // handler with a deterministic capture seam. Real dragging is covered above.
      terminal.setPointerCapture = () => {};
      terminal.releasePointerCapture = () => {};
      const before = window.domJourney.state().inputs.length;
      send("pointerdown");
      if (ending === "blur") window.dispatchEvent(new Event("blur"));
      else send(ending);
      send(ending === "blur" ? "lostpointercapture" : ending);
      send("pointerup");
      send("pointerdown");
      send("pointerup");
      return window.domJourney
        .state()
        .inputs.slice(before)
        .filter((s) => s.includes("mouse:"))
        .map((s) => s.split(":")[1]);
    }, ending);
    expect(result).toEqual(["down", "cancelled", "down", "up"]);
  });
}
