import { execFileSync } from "node:child_process";
import { expect, type Page, test } from "@playwright/test";
import type {} from "./compiled-wasm.fixture.ts";

// Deliberately operator-run: functional browser CI remains deterministic.
// Bounds and workloads are fixed in the coordination qualification document.
test.skip(
  process.env.SWIFTTUI_JSPI_QUALIFY !== "1",
  "Set SWIFTTUI_JSPI_QUALIFY=1 for measured qualification",
);

function browserCPU(): number {
  const processes = execFileSync("ps", ["-axo", "pid=,ppid=,time="], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .map((line) => {
      const [pid, ppid, time] = line.trim().split(/\s+/);
      const fields = time!.split(":").map(Number);
      let seconds = 0;
      for (const value of fields) seconds = seconds * 60 + value;
      return { pid: Number(pid), ppid: Number(ppid), seconds };
    });
  const descendants = new Set([process.pid]);
  for (let count = -1; count !== descendants.size; ) {
    count = descendants.size;
    for (const p of processes)
      if (descendants.has(p.ppid)) descendants.add(p.pid);
  }
  return processes
    .filter((p) => p.pid !== process.pid && descendants.has(p.pid))
    .reduce((sum, p) => sum + p.seconds, 0);
}
function quantile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return (
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ??
    0
  );
}
async function count(page: Page, scene: string, expected: number) {
  await page.waitForFunction(
    ({ scene, expected }) => {
      const f = window.__compiledWasm.snapshot().frames[scene];
      return f?.rows
        .map((r) => r.map((c) => c[1]).join(""))
        .join("\n")
        .includes(`${scene === "deep" ? "Deep" : "Alpha"} count ${expected}`);
    },
    { scene, expected },
    { timeout: 5000 },
  );
}
for (const scene of ["alpha", "animation", "deep"]) {
  for (const mode of ["worker", "main-thread"] as const) {
    test(`qualification ${scene} ${mode}`, async ({ page }, info) => {
      test.setTimeout(120_000);
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto("/compiled-wasm.html");
      await page.waitForFunction(() => !!window.__compiledWasm);
      const caps = await page.evaluate(
        () => window.__compiledWasm.snapshot().capabilities,
      );
      test.skip(
        mode === "main-thread" && !caps.supportsJSPI,
        "Engine has no JSPI",
      );
      await page.evaluate(
        ({ mode, scene }) => window.__compiledWasm.start(mode, scene),
        { mode, scene },
      );
      await page.waitForFunction(
        (scene) => !!window.__compiledWasm.snapshot().frames[scene],
        scene,
        { timeout: 30000 },
      );
      if (scene !== "animation") {
        await page.locator(".webhost-scene__terminal:visible").focus();
        await page.keyboard.press("Tab");
        await count(page, scene, 0);
      }
      const samples = [];
      const inputCount = scene === "deep" ? 5 : 50;
      for (let sample = 0; sample < 3; sample++) {
        const before = await page.evaluate(
          (scene) => window.__compiledWasm.snapshot().frameCounts[scene] ?? 0,
          scene,
        );
        await page.evaluate(() => window.__compiledWasm.beginSample());
        const cpuStart = browserCPU();
        const start = performance.now();
        if (scene !== "animation") {
          for (let i = 1; i <= inputCount; i++) {
            const expected = sample * inputCount + i;
            await page.evaluate(
              (n) => window.__compiledWasm.markInput(n),
              expected,
            );
            await page.keyboard.press("Enter");
            await count(page, scene, expected);
            await page.waitForTimeout(16);
          }
        }
        await page.waitForTimeout(
          Math.max(0, 3000 - (performance.now() - start)),
        );
        const wallMs = performance.now() - start;
        const cpuMs = (browserCPU() - cpuStart) * 1000;
        await page.evaluate(() => window.__compiledWasm.endSample());
        const state = await page.evaluate(() =>
          window.__compiledWasm.snapshot(),
        );
        const frames = (state.frameCounts[scene] ?? 0) - before;
        const result = {
          sample,
          wallMs,
          cpuMs,
          frames,
          fps: frames / (wallMs / 1000),
          inputSamples: state.inputLatencies.length,
          inputP95: quantile(state.inputLatencies, 0.95),
          inputMax: Math.max(0, ...state.inputLatencies),
          heartbeatP95: quantile(state.heartbeats, 0.95),
          heartbeatMax: Math.max(0, ...state.heartbeats),
        };
        samples.push(result);
        if (scene !== "animation") expect(result.inputSamples).toBe(inputCount);
      }
      await page.evaluate(() => window.__compiledWasm.suspend(true));
      const hiddenBefore = await page.evaluate(
        (scene) => window.__compiledWasm.snapshot().frameCounts[scene] ?? 0,
        scene,
      );
      await page.waitForTimeout(300);
      const hiddenAfter = await page.evaluate(
        (scene) => window.__compiledWasm.snapshot().frameCounts[scene] ?? 0,
        scene,
      );
      const resumedAt = performance.now();
      await page.evaluate(() => window.__compiledWasm.suspend(false));
      if (scene === "animation")
        await page.waitForFunction(
          ({ scene, hiddenAfter }) =>
            (window.__compiledWasm.snapshot().frameCounts[scene] ?? 0) >
            hiddenAfter,
          { scene, hiddenAfter },
          { timeout: 1000 },
        );
      else {
        await page.evaluate(
          (n) => window.__compiledWasm.markInput(n),
          3 * inputCount + 1,
        );
        await page.keyboard.press("Enter");
        await count(page, scene, 3 * inputCount + 1);
      }
      const resumeMs = performance.now() - resumedAt;
      const state = await page.evaluate(() => window.__compiledWasm.snapshot());
      const teardownAt = performance.now();
      await page.evaluate(() => window.__compiledWasm.dispose());
      if (mode === "main-thread")
        await page.waitForFunction(
          () => {
            const s = window.__compiledWasm.snapshot();
            return s.jspiStarts === s.jspiSettled;
          },
          {},
          { timeout: 2000 },
        );
      const result = {
        browser: info.project.name,
        version: page.context().browser()?.version(),
        mode,
        scene,
        cpuComplete: !(
          process.platform === "darwin" && info.project.name === "webkit"
        ),
        capabilities: caps,
        environments: state.environments,
        samples,
        hiddenFrames: hiddenAfter - hiddenBefore,
        resumeMs,
        teardownMs: performance.now() - teardownAt,
        errors: [...errors, ...state.errors],
      };
      console.log("JSPI-QUALIFICATION", JSON.stringify(result));
      await info.attach("qualification", {
        body: JSON.stringify(result, null, 2),
        contentType: "application/json",
      });
      expect(result.errors).toEqual([]);
      expect(result.hiddenFrames).toBeLessThanOrEqual(2);
    });
  }
}

test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus) return;
  const state = await page
    .evaluate(() => window.__compiledWasm?.snapshot())
    .catch(() => undefined);
  if (state)
    await info.attach("qualification-failure-state", {
      body: JSON.stringify(state, null, 2),
      contentType: "application/json",
    });
});
