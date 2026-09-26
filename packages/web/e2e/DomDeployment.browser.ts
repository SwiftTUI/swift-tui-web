import { expect, test } from "@playwright/test";
import type {} from "./compiled-wasm.fixture.ts";

// The host sets style properties and compiles WASM. Its declared policy allows
// those operations without permitting inline scripts or arbitrary script eval.
test("compiled DOM starts under the declared same-origin CSP", async ({
  page,
}) => {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy|violates.*directive/i.test(message.text()))
      violations.push(message.text());
  });
  await page.goto("/compiled-wasm.html?csp=1");
  await page.waitForFunction(() => !!window.__compiledWasm);
  await page.evaluate(() =>
    window.__compiledWasm.start("worker", "alpha", undefined, "dom"),
  );
  const button = page.getByRole("button", {
    name: "Increment Alpha",
    exact: true,
  });
  await expect(button).toBeAttached();
  await button.press("Enter");
  await expect(page.locator(".webhost-scene__surface-rows")).toContainText(
    "Alpha count 1",
  );
  expect(violations).toEqual([]);
  await page.evaluate(() => window.__compiledWasm.dispose());
});

test("blocked compiled WASM presents a visible failure", async ({ page }) => {
  await page.route("**/app.wasm", (route) =>
    route.fulfill({ status: 403, body: "blocked fixture asset" }),
  );
  await page.goto("/compiled-wasm.html");
  await page.waitForFunction(() => !!window.__compiledWasm);
  await page.evaluate(() =>
    window.__compiledWasm
      .start("worker", "alpha", undefined, "dom")
      .catch(() => {}),
  );
  await expect(page.locator(".webhost-scene__diagnostic")).toBeVisible();
  await expect(page.locator(".webhost-scene__diagnostic")).toContainText(
    /403|fetch|WASM|wasm/,
  );
  await page.evaluate(() => window.__compiledWasm.dispose());
});
