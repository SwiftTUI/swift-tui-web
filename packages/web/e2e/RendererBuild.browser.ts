import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { buildBrowserBundle } from "../../build/index.ts";
import type {} from "../src/browser.ts";

let directory: string;
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "swifttui-renderer-browser-"));
  for (const renderer of ["canvas", "dom"] as const) {
    await buildBrowserBundle({
      outputDirectory: join(directory, renderer),
      renderer,
    });
  }
});
test.afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

for (const renderer of ["canvas", "dom"] as const) {
  test(`${renderer} published bundle mounts only its selected surface and diagnoses an excluded renderer`, async ({
    page,
  }) => {
    const output = join(directory, renderer);
    const source = (
      await Promise.all(
        (
          await readdir(output)
        )
          .filter((path) => path.endsWith(".js"))
          .map((path) => readFile(join(output, path), "utf8")),
      )
    ).join("\n");
    expect(source).not.toContain(
      renderer === "canvas" ? "DomSurfacePainter" : "CanvasSurfacePainter",
    );
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.routeWebSocket("**/ws/scene/*", () => {});
    await page.route("http://bundle.test/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/scene-manifest.json") {
        await route.fulfill({
          json: {
            defaultSceneId: "main",
            scenes: [{ id: "main", isDefault: true }],
          },
        });
        return;
      }
      const contentType = path.endsWith(".js")
        ? "application/javascript"
        : path.endsWith(".woff2")
          ? "font/woff2"
          : "text/html";
      try {
        await route.fulfill({
          body: await readFile(
            join(output, path === "/" ? "index.html" : path.slice(1)),
          ),
          contentType,
        });
      } catch {
        await route.fulfill({ status: 404 });
      }
    });
    await page.goto("http://bundle.test/?token=test-token");
    await page.waitForFunction(() => !!window.__WEBTUI_APP__);
    await expect(page.locator("canvas.webhost-scene__surface")).toHaveCount(
      renderer === "canvas" ? 1 : 0,
    );
    await expect(page.locator(".webhost-scene__surface--dom")).toHaveCount(
      renderer === "dom" ? 1 : 0,
    );
    const excluded = renderer === "canvas" ? "dom" : "canvas";
    await page.goto(
      `http://bundle.test/?token=test-token&renderer=${excluded}`,
    );
    await expect(page.getByRole("alert")).toContainText(
      `The ${excluded} renderer is not included in this browser build.`,
    );
    expect(errors).toEqual([]);
  });
}
