import { expect, test } from "@playwright/test";
import type {} from "./accessibility-preferences.fixture.ts";

for (const renderer of ["canvas", "dom"]) {
  test(`${renderer} preference controls update retained/new scenes and survive reload`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`/?renderer=${renderer}`);
    await page.addScriptTag({
      type: "module",
      url: "/accessibility-preferences.js",
    });
    await expect
      .poll(() =>
        page.evaluate(
          () => window.__accessibilityPreferences?.styles.alpha?.reduceMotion,
        ),
      )
      .toBe("true");
    await page.getByText("Accessibility settings", { exact: true }).click();
    await page
      .getByRole("combobox", { name: "Reduce motion", exact: true })
      .selectOption("off");
    await page
      .getByRole("combobox", { name: "Contrast", exact: true })
      .selectOption("increased");
    await page
      .getByRole("combobox", {
        name: "Differentiate without color",
        exact: true,
      })
      .selectOption("on");
    await page
      .getByRole("combobox", { name: "Reduce transparency", exact: true })
      .selectOption("on");
    await page
      .getByRole("combobox", { name: "Color profile", exact: true })
      .selectOption("monochrome");
    const expected = {
      reduceMotion: "false",
      contrast: "increased",
      differentiateWithoutColor: "true",
      reduceTransparency: "true",
      colorProfile: "monochrome",
    };
    await expect
      .poll(() =>
        page.evaluate(() => window.__accessibilityPreferences.styles.alpha),
      )
      .toMatchObject(expected);
    await page.evaluate(() =>
      window.__accessibilityPreferences.switchScene("beta"),
    );
    await expect
      .poll(() =>
        page.evaluate(() => window.__accessibilityPreferences.styles.beta),
      )
      .toMatchObject(expected);
    await page
      .getByRole("combobox", { name: "Reduce transparency", exact: true })
      .selectOption("off");
    await expect
      .poll(() =>
        page.evaluate(() => [
          window.__accessibilityPreferences.styles.alpha.reduceTransparency,
          window.__accessibilityPreferences.styles.beta.reduceTransparency,
        ]),
      )
      .toEqual(["false", "false"]);
    expect(
      await page.evaluate(() => window.__accessibilityPreferences.inputs),
    ).toEqual([]);
    await page.reload();
    await page.addScriptTag({
      type: "module",
      url: "/accessibility-preferences.js",
    });
    await expect
      .poll(() =>
        page.evaluate(
          () => window.__accessibilityPreferences?.styles.alpha?.reduceMotion,
        ),
      )
      .toBe("false");
    await page.getByText("Accessibility settings", { exact: true }).click();
    await expect(
      page.getByRole("combobox", { name: "Reduce motion", exact: true }),
    ).toHaveValue("off");
    await page
      .getByRole("button", { name: "Use system settings", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(
          () => window.__accessibilityPreferences.styles.alpha.reduceMotion,
        ),
      )
      .toBe("true");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await expect
      .poll(() =>
        page.evaluate(
          () => window.__accessibilityPreferences.styles.alpha.reduceMotion,
        ),
      )
      .toBe("false");
    await page.evaluate(() => window.__accessibilityPreferences.dispose());
    await expect(
      page.getByText("Accessibility settings", { exact: true }),
    ).toHaveCount(0);
  });
}
