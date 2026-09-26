import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import manifest from "../fonts/manifest.json" with { type: "json" };
import type {} from "./dom-typography.fixture.ts";
import { qualifyFont } from "./font-qualification.ts";

test("released font bytes preserve face advances and baselines across the size corpus", async ({
  page,
  browser,
}, info) => {
  for (const face of manifest.faces) {
    const bytes = await readFile(
      new URL(`../fonts/${face.file}`, import.meta.url),
    );
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(face.sha256);
    expect(bytes.length).toBe(face.bytes);
  }
  expect(
    manifest.faces.reduce((sum, face) => sum + face.bytes, 0),
  ).toBeLessThanOrEqual(400 * 1024);
  await page.goto("/health");
  const results = await page.evaluate(qualifyFont, manifest.faces);
  await info.attach("font-metrics", {
    body: JSON.stringify(
      { ...results, browserVersion: browser.version(), manifest },
      null,
      2,
    ),
    contentType: "application/json",
  });
  expect(results.loaded).toEqual(["loaded", "loaded", "loaded", "loaded"]);
  for (const size of [12, 14, 16, 20, 24, 32]) {
    const rows = results.measurements.filter((r) => r.size === size);
    expect(
      Math.max(...rows.map((r) => r.advance)) -
        Math.min(...rows.map((r) => r.advance)),
    ).toBeLessThanOrEqual(0.02);
    expect(
      Math.max(...rows.map((r) => r.baseline)) -
        Math.min(...rows.map((r) => r.baseline)),
    ).toBeLessThanOrEqual(0.5);
    for (const row of rows) {
      // Platform font hinting can quantize the nominal 0.6-em advance to a
      // whole CSS pixel (Chromium/FreeType on Linux). Face and sample equality
      // above/below stay strict; a macOS fractional advance is not universal.
      expect(Math.abs(row.advance - size * 0.6)).toBeLessThanOrEqual(0.5);
      for (const sample of row.samples)
        expect(
          Math.abs(sample.width - row.advance),
          `${row.face}/${size}/${sample.text}`,
        ).toBeLessThanOrEqual(0.05);
    }
  }
  await info.attach("font-corpus", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
});

test("wire lead cells preserve Unicode, order and allocation through replacement", async ({
  page,
}, info) => {
  await page.goto("/health");
  await page.evaluate(async (faces) => {
    HTMLCanvasElement.prototype.getContext = () => {
      throw new Error("Canvas requested by DOM painter");
    };
    await Promise.all(
      faces.map(async (face) => {
        const font = new FontFace(
          "SwiftTUI Qualification",
          `url(/fonts/${face.file})`,
          { weight: String(face.weight), style: face.style },
        );
        await font.load();
        document.fonts.add(font);
      }),
    );
  }, manifest.faces);
  await page.addScriptTag({ url: "/dom-typography.js", type: "module" });
  await page.waitForFunction(() => !!window.typography);
  for (const size of [12, 14, 16, 20, 24, 32]) {
    const { cw, ch } = await page.evaluate(
      (size) => window.typography.paint(size),
      size,
    );
    const rows = page.locator(".webhost-scene__surface-row");
    await expect(rows).toHaveCount(5);
    const result = await page.evaluate(() => {
      const root = document
        .querySelector("#typography")!
        .getBoundingClientRect();
      return [...document.querySelectorAll(".webhost-scene__surface-row")].map(
        (row, y) => {
          const samples =
            y < 4
              ? window.typography.samples
              : [
                  [1, "W", 1, 0],
                  [200, "W", 1, 0],
                ];
          return samples.map(([x, text]) => {
            const cell = [...row.children].find((e) => {
              const start = Number(e.getAttribute("data-column"));
              return (
                Number(x) >= start &&
                Number(x) < start + Number(e.getAttribute("data-span"))
              );
            })!;
            if (!text) return { text: "", x: Number(x), y: 0, interior: false };
            const offset = Number(x) - Number(cell.getAttribute("data-column"));
            const range = document.createRange();
            range.setStart(cell.firstChild!, offset);
            range.setEnd(cell.firstChild!, offset + String(text).length);
            const rect =
              offset === 0 && getComputedStyle(cell).display !== "contents"
                ? cell.getBoundingClientRect()
                : range.getBoundingClientRect();
            return {
              text: range.toString(),
              x: rect.x - root.x,
              y: row.getBoundingClientRect().y - root.y,
              interior: offset > 0,
            };
          });
        },
      );
    });
    const samples = await page.evaluate(() => window.typography.samples);
    for (const [y, row] of result.slice(0, 4).entries()) {
      for (const [i, cell] of row.entries()) {
        const [x, text] = samples[i]!;
        expect(cell.text).toBe(text);
        if (!text) continue;
        expect(
          Math.abs(cell.x - x * cw),
          JSON.stringify({ size, y, x, text, cell }),
        ).toBeLessThanOrEqual(cell.interior ? 1 + 1 / 32 : 0.5);
        expect(cell.y).toBeCloseTo(y * ch, 1);
      }
    }
    for (const [i, x] of [1, 200].entries())
      expect(Math.abs(result[4]![i]!.x - x * cw)).toBeLessThanOrEqual(
        1 + 1 / 32,
      );
    await info.attach(`unicode-${size}`, {
      body: await page.locator("#typography").screenshot(),
      contentType: "image/png",
    });
    await page.evaluate((size) => window.typography.paint(size, true), size);
    await expect(rows.first().locator('[data-column="3"]')).toHaveText("n");
  }
  await page.evaluate(() => window.typography.dispose());
  await expect(page.locator("#typography")).toBeEmpty();
});
