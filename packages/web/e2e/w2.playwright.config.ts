import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

// Campaign-two W2 browser journeys (STUI-1157). One Chromium worker against a
// dedicated fixture server on a port distinct from the shipped browser lane's
// 4173, so this suite never collides with the organization browser gate.
const port = process.env.SWIFTTUI_BROWSER_JOURNEY_PORT ?? "4273";
const origin = `http://127.0.0.1:${port}`;
const artifacts = fileURLToPath(
  new URL("../../../.build/w2-journey/", import.meta.url),
);

export default defineConfig({
  testDir: ".",
  testMatch: "*.w2.browser.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 20_000,
  expect: { timeout: 8_000 },
  forbidOnly: !!process.env.CI,
  outputDir: `${artifacts}/playwright-results`,
  reporter: [["line"], ["json", { outputFile: `${artifacts}/results.json` }]],
  use: {
    baseURL: origin,
    headless: true,
    screenshot: "only-on-failure",
    trace: "off",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "bun run w2-serve.ts",
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    url: `${origin}/health`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: { SWIFTTUI_BROWSER_JOURNEY_PORT: port },
  },
});
