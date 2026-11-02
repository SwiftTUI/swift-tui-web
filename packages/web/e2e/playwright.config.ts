import { fileURLToPath } from "node:url";
import { defineConfig, devices, webkit } from "@playwright/test";

import { browserJourneyOrigin } from "./journey-environment.ts";

const executablePath = process.env.SWIFTTUI_BROWSER_EXECUTABLE;
const artifacts = fileURLToPath(
  new URL("../../../.build/browser-journey/", import.meta.url),
);

export default defineConfig({
  testDir: ".",
  testMatch: "*.browser.ts",
  // The W2 adversarial journeys need their own fixture server and build;
  // they run under w2.playwright.config.ts (`bun run test:browser:w2`).
  testIgnore: "*.w2.browser.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  forbidOnly: !!process.env.CI,
  outputDir: `${artifacts}/playwright-results`,
  reporter: [
    ["line"],
    ["json", { outputFile: `${artifacts}/results.json` }],
    ["html", { outputFolder: `${artifacts}/report`, open: "never" }],
  ],
  use: {
    baseURL: browserJourneyOrigin,
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: executablePath ? { executablePath } : undefined,
      },
    },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    {
      name: "webkit",
      use: {
        ...devices["Desktop Safari"],
        // STUI-909: pinned macOS WebKit leaks native window-animation threads
        // while the display sleeps. Keep the preference local to this process.
        // The wrapper preserves Playwright's default arguments (including headed
        // mode); its argument validator cannot accept the separate value "NO".
        launchOptions:
          process.platform === "darwin"
            ? {
                executablePath: fileURLToPath(
                  new URL("./webkit-macos.sh", import.meta.url),
                ),
                env: {
                  ...process.env,
                  SWIFTTUI_WEBKIT_EXECUTABLE: webkit.executablePath(),
                },
              }
            : undefined,
      },
    },
  ],
  webServer: {
    command: "bun run serve.ts",
    url: `${browserJourneyOrigin}/health`,
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
