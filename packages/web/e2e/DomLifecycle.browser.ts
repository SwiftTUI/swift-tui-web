import { expect, test } from "@playwright/test";
import type {} from "./compiled-wasm.fixture.ts";

for (const mode of ["worker", "main-thread"] as const) {
  test(`DOM disposal while ${mode} WASM loads prevents late presentation and settles execution`, async ({
    page,
  }) => {
    let started = 0,
      closed = 0,
      requested = false;
    page.on("worker", (worker) => {
      started++;
      worker.on("close", () => closed++);
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/app.wasm", async (route) => {
      requested = true;
      await gate;
      await route.continue().catch(() => {});
    });
    await page.goto("/compiled-wasm.html");
    await page.waitForFunction(() => !!window.__compiledWasm);
    const caps = await page.evaluate(
      () => window.__compiledWasm.snapshot().capabilities,
    );
    test.skip(
      mode === "main-thread" && !caps.supportsJSPI,
      "Engine has no JSPI",
    );
    try {
      await page.evaluate(
        (mode) => window.__compiledWasm.start(mode, "alpha", undefined, "dom"),
        mode,
      );
      await expect.poll(() => requested).toBe(true);
      await page.evaluate(() => window.__compiledWasm.dispose());
      await expect(page.locator("#wasm-mount")).toBeEmpty();
      await expect.poll(() => closed, { timeout: 2000 }).toBe(started);
      const state = await page.evaluate(() => {
        const observed = { mutations: 0 };
        new MutationObserver((records) => {
          observed.mutations += records.length;
        }).observe(document.querySelector("#wasm-mount")!, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
        Object.assign(window, { __lifecycle: observed });
        return window.__compiledWasm.snapshot().paints;
      });
      release();
      await page.waitForTimeout(300);
      const result = await page.evaluate(() => ({
        mutations: (window as unknown as { __lifecycle: { mutations: number } })
          .__lifecycle.mutations,
        paints: window.__compiledWasm.snapshot().paints,
        frames: Object.keys(window.__compiledWasm.snapshot().frames),
        errors: window.__compiledWasm.snapshot().errors,
      }));
      expect(result).toEqual({
        mutations: 0,
        paints: state,
        frames: [],
        errors: [],
      });
    } finally {
      release();
    }
  });
}

test("DOM worker failure shows a diagnostic and closes its execution resources", async ({
  page,
}) => {
  let started = 0,
    closed = 0;
  page.on("worker", (worker) => {
    started++;
    worker.on("close", () => closed++);
  });
  await page.route("**/compiled-wasm-worker.js", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      headers: {
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Cross-Origin-Resource-Policy": "same-origin",
      },
      body: "self.onmessage = () => {};",
    }),
  );
  await page.goto("/compiled-wasm.html");
  await page.waitForFunction(() => !!window.__compiledWasm);
  const workerReady = page.waitForEvent("worker");
  await page.evaluate(() =>
    window.__compiledWasm.start("worker", "alpha", undefined, "dom"),
  );
  const worker = await workerReady;
  // Inject failure after the browser has exposed the worker. An immediate
  // top-level throw can terminate it before Chromium reports its existence.
  await worker.evaluate(() => {
    setTimeout(() => {
      throw new Error("Injected worker failure");
    }, 0);
  });
  await expect(page.locator(".webhost-scene__diagnostic")).toContainText(
    "worker failed",
  );
  await expect.poll(() => closed, { timeout: 2000 }).toBe(started);
  expect(started).toBe(1);
  await page.evaluate(() => window.__compiledWasm.dispose());
  await expect(page.locator("#wasm-mount")).toBeEmpty();
});

test("DOM without isolation either presents through JSPI or reports required headers", async ({
  page,
}) => {
  await page.goto("/compiled-wasm.html?no-isolation");
  await page.waitForFunction(() => !!window.__compiledWasm);
  const caps = await page.evaluate(
    () => window.__compiledWasm.snapshot().capabilities,
  );
  expect(caps.sharedArrayBuffer).toBe(false);
  await page.evaluate(() =>
    window.__compiledWasm.start("auto", "alpha", undefined, "dom"),
  );
  if (caps.supportsJSPI) {
    await expect(page.locator(".webhost-scene__surface-rows")).toContainText(
      "Alpha count 0",
    );
  } else {
    await expect(page.locator(".webhost-scene__diagnostic")).toContainText(
      "COOP/COEP headers",
    );
  }
  await page.evaluate(() => window.__compiledWasm.dispose());
  await expect(page.locator("#wasm-mount")).toBeEmpty();
});
