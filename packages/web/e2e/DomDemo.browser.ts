import { expect, test } from "@playwright/test";

test("DOM demo starts on navigation and reload without a manual start", async ({
  page,
}) => {
  await page.goto("/dom-demo.html");
  await expect(
    page.getByRole("spinbutton", { name: "Quantity", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".webhost-scene__surface--dom")).toBeVisible();
  await expect(page.locator("#status")).toBeHidden();

  await page.reload();
  await expect(
    page.getByRole("spinbutton", { name: "Quantity", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Scene", exact: true })
    .selectOption("alpha");
  await page
    .getByRole("button", { name: "Increment Alpha", exact: true })
    .press("Enter");
  await expect(
    page.locator(".webhost-scene__surface-rows:visible"),
  ).toContainText("Alpha count 1");
});
