import { expect, test } from "@playwright/test";

// STUI-909 reduced reproducer: no SwiftTUI runtime or fixture script is loaded.
// Fresh contexts must keep navigating in one browser process beyond the macOS
// WebKit window-animation exhaustion boundary (observed around page 90).
test("fresh contexts keep navigating through a long browser session", async ({
  browser,
  baseURL,
}) => {
  // 120 fresh native windows exceed the ordinary one-journey minute on Linux
  // CI. Bound each page separately while retaining all 120 iterations.
  test.setTimeout(180_000);
  for (let iteration = 1; iteration <= 120; iteration++) {
    await test.step(`fresh page ${iteration}`, async () => {
      const context = await browser.newContext();
      context.setDefaultTimeout(10_000);
      context.setDefaultNavigationTimeout(10_000);
      try {
        const page = await context.newPage();
        const response = await page.goto(`${baseURL}/health`);
        expect(response?.status()).toBe(200);
        await expect(page.locator("body")).toHaveText("ok");
      } finally {
        await context.close();
      }
    });
  }
});
