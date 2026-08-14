import { defineConfig, devices } from "@playwright/test";

import { browserJourneyOrigin } from "./journey-environment.ts";

const executablePath = process.env.SWIFTTUI_BROWSER_EXECUTABLE;

export default defineConfig({
  testDir: ".",
  testMatch: "*.browser.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  outputDir: "../../../.build/browser-journey/playwright-results",
  reporter: [
    ["line"],
    ["json", { outputFile: "../../../.build/browser-journey/results.json" }],
  ],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: browserJourneyOrigin,
    browserName: "chromium",
    channel: executablePath ? undefined : "chrome",
    headless: true,
    launchOptions: executablePath ? { executablePath } : undefined,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "bun run serve.ts",
    url: `${browserJourneyOrigin}/health`,
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
