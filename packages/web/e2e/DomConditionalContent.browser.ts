import { expect, test } from "@playwright/test";
import type {} from "./compiled-wasm.fixture.ts";

test("conditional content stays visible and in copy order after removal and reinsertion", async ({
  page,
}) => {
  await page.goto("/compiled-wasm.html?renderer=dom");
  await page.getByRole("button", { name: "Start accessibility scene" }).click();
  const toggle = page.getByRole("button", {
    name: "Toggle control",
    exact: true,
  });
  await expect(toggle).toBeAttached();
  const removable = page.getByRole("button", {
    name: "Removable",
    exact: true,
  });
  for (let step = 0; step < 7; step += 1) {
    if (step > 0) await toggle.press("Enter");
    await expect(removable).toHaveCount(step % 2 === 0 ? 1 : 0);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const frame = window.__compiledWasm.snapshot().frames.accessibility!;
          const rows = document.querySelectorAll(".webhost-scene__surface-row");
          const failures: string[] = [];
          for (const [y, cells] of frame.rows.entries()) {
            const text = cells.map((cell) => cell[1]).join("");
            if (!/Removable|Focus Name|Decorative/.test(text)) continue;
            const row = rows[y];
            if (!row) {
              failures.push(`missing row ${y}`);
              continue;
            }
            if (
              row.textContent !==
              text + (y < frame.rows.length - 1 ? "\n" : "")
            )
              failures.push(`copy order differs in row ${y}`);
            const bounds = row.getBoundingClientRect();
            for (const run of row.children) {
              if (!run.textContent?.trim()) continue;
              const range = document.createRange();
              range.selectNodeContents(run);
              for (const ink of range.getClientRects()) {
                if (ink.bottom <= bounds.top || ink.top >= bounds.bottom)
                  failures.push(`text clipped outside row ${y}`);
              }
            }
          }
          return failures;
        }),
      )
      .toEqual([]);
  }
  await page.evaluate(() => window.__compiledWasm.dispose());
});
