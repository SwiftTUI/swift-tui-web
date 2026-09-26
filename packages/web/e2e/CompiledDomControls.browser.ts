import { expect, type Page, test } from "@playwright/test";
import type {} from "./compiled-wasm.fixture.ts";

// Secure edits stay in the page; no trace, screenshot, snapshot or payload artifact.
test.use({ trace: "off", screenshot: "off", video: "off" });
async function start(page: Page, renderer: "dom" | "canvas", scene: string) {
  await page.goto("/compiled-wasm.html");
  await page.waitForFunction(() => !!window.__compiledWasm);
  await page.evaluate(
    ({ renderer, scene }) => {
      window.__compiledWasm.resizeMount(960, 700);
      return window.__compiledWasm.start("worker", scene, undefined, renderer);
    },
    { renderer, scene },
  );
}
async function text(page: Page, scene: string) {
  return page.evaluate(
    (scene) =>
      window.__compiledWasm
        .snapshot()
        .frames[scene]?.rows.map((row) => row.map((cell) => cell[1]).join(""))
        .join("\n") ?? "",
    scene,
  );
}
for (const renderer of ["canvas", "dom"] as const) {
  test(`${renderer}: compiled controls, Unicode, shapes and presentation own Swift state`, async ({
    page,
  }) => {
    await start(page, renderer, "controls");
    const quantity = page.getByRole("spinbutton", {
      name: "Quantity",
      exact: true,
    });
    await expect(quantity).toBeAttached();
    await quantity.press("ArrowUp");
    await expect.poll(() => text(page, "controls")).toContain("Quantity 2");
    // Picker's tagged shared contract has no typed adjustment action; exercise
    // its real pointer route instead of inventing an assistive action in JS.
    const optionPoint = await page.evaluate(() => {
      const frame = window.__compiledWasm.snapshot().frames.controls!;
      const y = frame.rows.findIndex((row) =>
        row
          .map((cell) => cell[1])
          .join("")
          .includes("Second"),
      );
      const row = frame.rows[y]!;
      const column = row
        .map((cell) => cell[1])
        .join("")
        .indexOf("Second");
      const bounds = document
        .querySelector(".webhost-scene__surface")!
        .getBoundingClientRect();
      return {
        x: bounds.left + ((column + 2.5) * bounds.width) / frame.width,
        y: bounds.top + ((y + 0.5) * bounds.height) / frame.height,
      };
    });
    await page.mouse.click(optionPoint.x, optionPoint.y);
    await expect.poll(() => text(page, "controls")).toContain("Choice 1");
    const disclosure = page.getByRole("region", {
      name: "Details",
      exact: true,
    });
    await disclosure.press("Enter");
    await expect
      .poll(() => text(page, "controls"))
      .toContain("Expanded Café 漢字 🙂");
    const notes = page.getByRole("textbox", { name: "Notes", exact: true });
    await notes.fill("Updated Café\n漢字 🙂");
    await expect.poll(() => text(page, "controls")).toContain("Updated Café");
    await page
      .getByRole("button", { name: "Show sheet", exact: true })
      .press("Enter");
    await expect(
      page.getByRole("button", { name: "Complete sheet", exact: true }),
    ).toBeAttached();
    await page
      .getByRole("button", { name: "Complete sheet", exact: true })
      .press("Enter");
    await expect.poll(() => text(page, "controls")).toContain("Sheets 1");
    await page
      .getByRole("button", { name: "Launch process", exact: true })
      .press("Enter");
    await expect
      .poll(() => text(page, "controls"))
      .toContain("Unavailable: WASI has no PTY process service");
    await page.evaluate(() => window.__compiledWasm.resizeMount(740, 640));
    await expect
      .poll(() => text(page, "controls"))
      .toContain("Quantity 2 Choice 1 Sheets 1");
    expect(
      await page.evaluate(() => window.__compiledWasm.snapshot().errors),
    ).toEqual([]);
    if (renderer === "dom") {
      await expect(page.locator(".webhost-scene__surface-rows")).toContainText(
        "Updated Café",
      );
      expect(
        await page.locator(".webhost-scene__surface--dom canvas").count(),
      ).toBe(0);
    }
    await page.evaluate(() => window.__compiledWasm.dispose());
    await expect(page.locator("#wasm-mount")).toBeEmpty();
  });

  test(`${renderer}: compiled text, composition, paste and secure edits mutate once`, async ({
    page,
  }) => {
    await start(page, renderer, "accessibility");
    const name = page.getByRole("textbox", { name: "Name", exact: true });
    await expect(name).toBeAttached();
    await name.fill("Café 漢字 🙂");
    await expect
      .poll(() => text(page, "accessibility"))
      .toContain("Name edits 1 Password edits 0");
    await name.evaluate((input) => {
      const field = input as HTMLInputElement;
      field.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      );
      field.value = "e";
      field.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          isComposing: true,
          inputType: "insertCompositionText",
        }),
      );
      field.value = "é";
      field.dispatchEvent(
        new CompositionEvent("compositionend", { bubbles: true, data: "é" }),
      );
      field.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertFromComposition",
        }),
      );
    });
    await expect
      .poll(() => text(page, "accessibility"))
      .toContain("Name edits 2 Password edits 0");
    await expect(name).toHaveValue("é");
    // Use the actual browser clipboard path, populated from a disposable DOM field.
    await page.evaluate(() => {
      const source = document.createElement("textarea");
      source.id = "clipboard-source";
      source.value = "Pasted Café";
      document.body.append(source);
      source.focus();
      source.select();
    });
    const command = process.platform === "darwin" ? "Meta" : "Control";
    await expect(page.locator("#clipboard-source")).toBeFocused();
    await page.keyboard.press(`${command}+c`);
    await name.focus();
    await page.keyboard.press(`${command}+a`);
    await page.keyboard.press(`${command}+v`);
    await expect
      .poll(() => text(page, "accessibility"))
      .toContain("Name edits 3 Password edits 0");
    await expect(name).toHaveValue("Pasted Café");
    const secure = page.getByLabel("Password", { exact: true });
    await secure.focus();
    const result = await secure.evaluate((input) => {
      const value = crypto.randomUUID();
      const field = input as HTMLInputElement;
      field.value = value;
      field.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertText" }),
      );
      const cleanDOM = !document.documentElement.outerHTML.includes(value);
      const cleanDiagnostics = !JSON.stringify(
        window.__compiledWasm.snapshot(),
      ).includes(value);
      return { cleanDOM, cleanDiagnostics };
    });
    expect(result).toEqual({ cleanDOM: true, cleanDiagnostics: true });
    await expect
      .poll(() => text(page, "accessibility"))
      .toContain("Name edits 3 Password edits 1");
    expect(
      await page.evaluate(
        () =>
          window.__compiledWasm
            .snapshot()
            .frames.accessibility?.accessibilityTree?.find(
              (n) => n.role === "secureField",
            )?.value,
      ),
    ).toBeUndefined();
    await name.focus();
    await expect(secure).toHaveValue("");
    await page
      .getByRole("button", { name: "Activate", exact: true })
      .press("Enter");
    await expect
      .poll(() => text(page, "accessibility"))
      .toContain("Activated 1");
    await page
      .getByRole("checkbox", { name: "Enabled", exact: true })
      .press("Space");
    await expect(
      page.getByRole("checkbox", { name: "Enabled", exact: true }),
    ).toHaveAttribute("aria-checked", "true");
    await page
      .getByRole("slider", { name: "Gain", exact: true })
      .press("ArrowUp");
    await expect(
      page.getByRole("slider", { name: "Gain", exact: true }),
    ).toHaveAttribute("aria-valuenow", "3");
    await page
      .getByRole("button", { name: "Unavailable", exact: true })
      .press("Enter");
    await expect
      .poll(() => text(page, "accessibility"))
      .toContain("Activated 1");
    await page.evaluate(() => window.__compiledWasm.switchScene("beta"));
    await page.evaluate(() =>
      window.__compiledWasm.switchScene("accessibility"),
    );
    await expect
      .poll(() => text(page, "accessibility"))
      .toContain("Name edits 3 Password edits 1");
    await page.evaluate(() => window.__compiledWasm.dispose());
  });

  test(`${renderer}: nested scroll and retained scene state use compiled Swift`, async ({
    page,
  }) => {
    await start(page, renderer, "scrolling");
    await expect.poll(() => text(page, "scrolling")).toContain("Nested row 0");
    const regions = await page.evaluate(
      () =>
        window.__compiledWasm.snapshot().frames.scrolling?.scrollRegions ?? [],
    );
    expect(regions.length).toBeGreaterThanOrEqual(2);
    await page
      .getByRole("button", { name: "Choose row 0", exact: true })
      .press("Enter");
    await expect
      .poll(() => text(page, "scrolling"))
      .toContain("Selected row 0");
    await page.evaluate(() => window.__compiledWasm.switchScene("beta"));
    await page.evaluate(() => window.__compiledWasm.switchScene("scrolling"));
    await expect
      .poll(() => text(page, "scrolling"))
      .toContain("Selected row 0");
    await page.evaluate(() => window.__compiledWasm.dispose());
  });
}
