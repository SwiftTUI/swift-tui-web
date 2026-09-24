import { expect, test } from "@playwright/test";
import type {} from "./geometry-corpus.fixture.ts";

for (const transport of ["wasi", "websocket"] as const) {
  for (const renderer of ["dom", "canvas"] as const) {
    test(`Swift geometry corpus through ${transport} and ${renderer}`, async ({
      page,
    }) => {
      await page.goto("/health");
      await page.addScriptTag({ url: "/geometry-corpus.js", type: "module" });
      await page.waitForFunction(() => !!window.runGeometryCorpus);
      const result = await page.evaluate(
        ({ transport, renderer }) =>
          window.runGeometryCorpus(transport, renderer),
        { transport, renderer },
      );
      expect(result.decoded).toEqual([
        0,
        1,
        2,
        1,
        3,
        3,
        0,
        Number.MAX_SAFE_INTEGER,
      ]);
      expect(result.painted).toEqual([1, 2, 3, 3, Number.MAX_SAFE_INTEGER]);
      if (renderer === "dom") {
        expect(result.children).toBe(2);
        expect(result.text).toBe("abcd\n宽e ");
      }
    });
  }
}
