import { expect, test } from "@playwright/test";
import type {} from "./dom-surface.fixture.ts";

const modifier = process.platform === "darwin" ? "Meta" : "Control";
test.beforeEach(async ({ page }) => {
  await page.goto("/health");
  await page.addScriptTag({ url: "/dom-surface.js", type: "module" });
  await page.waitForFunction(() => !!window.domJourney);
});

test("keyboard selection and scoped select-all copy the viewport without application input", async ({
  page,
  browserName,
}) => {
  const baseline = await page.evaluate(
    () => window.domJourney.state().inputs.length,
  );
  // Safari's default keyboard navigation reaches all controls with Option+Tab.
  await page.keyboard.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
  const toggle = page.getByRole("button", { name: "Select text", exact: true });
  await expect(toggle).toBeFocused();
  await page.keyboard.press("Space");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  for (let i = 0; i < 6; i++) await page.keyboard.press("Shift+ArrowRight");
  expect(await page.evaluate(() => window.domJourney.state().selected)).toBe(
    "Select",
  );
  await page.keyboard.press(`${modifier}+a`);
  const expected = await page
    .locator(".webhost-scene__surface-rows")
    .textContent();
  const selected = await page.evaluate(
    () => document.getSelection()!.getRangeAt(0).cloneContents().textContent,
  );
  expect(selected).toBe(expected);
  await page.keyboard.press(`${modifier}+c`);
  await page.keyboard.press("Escape");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(toggle).toBeFocused();
  expect(
    await page.evaluate(() => window.domJourney.state().inputs.length),
  ).toBe(baseline);
  await page.evaluate(() => {
    const target = document.createElement("textarea");
    target.id = "selection-paste";
    document.body.append(target);
    target.focus();
  });
  await page.keyboard.press(`${modifier}+v`);
  await expect(page.locator("#selection-paste")).toHaveValue(expected!);
  await page.locator(".webhost-scene__terminal").focus();
  await page.keyboard.press("ArrowRight");
  expect(
    await page.evaluate(() => window.domJourney.state().inputs.length),
  ).toBe(baseline + 1);
});

test("selection mode yields plain drags and suppresses link activation until exit", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Select text", exact: true }).click();
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
  expect(
    await page.evaluate(() => window.domJourney.state().selected),
  ).toBeTruthy();
  await page.locator("a[data-surface-link]").click();
  expect(await page.evaluate(() => window.domJourney.state().opened)).toEqual(
    [],
  );
  expect(
    await page.evaluate(() => window.domJourney.state().inputs.length),
  ).toBe(baseline);
  await page.keyboard.press("Escape");
  await page.evaluate(() => document.getSelection()?.removeAllRanges());
  await page.locator("a[data-surface-link]").click();
  expect(await page.evaluate(() => window.domJourney.state().opened)).toEqual([
    "https://example.com/swifttui",
  ]);
});

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
            clientY: rect.top + 3,
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
