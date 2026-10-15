import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildBrowserBundle, parseWebRenderer } from "./buildBrowserBundle.ts";

test("browser builds package only the chosen renderer, including when rebuilding DOM as Canvas", async () => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "swifttui-renderer-"));
  async function scripts(): Promise<string> {
    return (
      await Promise.all(
        (
          await readdir(outputDirectory)
        )
          .filter((name) => name.endsWith(".js"))
          .map((name) => readFile(join(outputDirectory, name), "utf8")),
      )
    ).join("\n");
  }
  try {
    await buildBrowserBundle({ outputDirectory, renderer: "dom" });
    const dom = await scripts();
    expect(dom).toContain("DomSurfacePainter");
    expect(dom).toContain("DomFontResources");
    expect(dom).not.toContain("CanvasSurfacePainter");
    const fontPath = join(
      outputDirectory,
      "assets/swifttui-fonts/7d231a426067",
    );
    expect(
      (await readdir(fontPath)).filter((name) => name.endsWith(".woff2")),
    ).toHaveLength(4);
    expect(
      (await readFile(join(fontPath, "LICENSE.md"), "utf8")).toUpperCase(),
    ).toContain("SIL OPEN FONT LICENSE");
    await writeFile(
      join(outputDirectory, "app.wasm"),
      "preserve packaged wasm",
    );
    await buildBrowserBundle({ outputDirectory });
    const canvas = await scripts();
    expect(canvas).toContain("CanvasSurfacePainter");
    expect(canvas).not.toContain("DomSurfacePainter");
    expect(canvas).not.toContain("DomFontResources");
    expect(canvas).not.toContain("IoskeleyMono-");
    expect(await Bun.file(join(outputDirectory, "index.html")).exists()).toBe(
      true,
    );
    expect(await Bun.file(join(fontPath, "LICENSE.md")).exists()).toBe(false);
    expect(await readFile(join(outputDirectory, "app.wasm"), "utf8")).toBe(
      "preserve packaged wasm",
    );
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test("renderer validation rejects unsupported selections", () => {
  expect(parseWebRenderer()).toBe("canvas");
  expect(() => parseWebRenderer("webgl")).toThrow("expected canvas or dom");
});

test.each(["canvas", "dom"] as const)(
  "%s builds default to their packaged renderer and reject unavailable renderers",
  async (renderer) => {
    const result = await Bun.build({
      entrypoints: [
        resolve(import.meta.dir, "../../../web/src/SurfaceRenderer.ts"),
      ],
      target: "bun",
      define: { SWIFTTUI_WEB_RENDERER: JSON.stringify(renderer) },
      minify: { syntax: true },
    });
    expect(result.success).toBe(true);
    const source = await result.outputs[0]!.text();
    const module = await import(
      `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
    );
    expect(module.resolveSurfaceRenderer()).toBe(renderer);
    expect(module.resolveSurfaceRenderer(renderer)).toBe(renderer);
    expect(() =>
      module.resolveSurfaceRenderer(renderer === "canvas" ? "dom" : "canvas"),
    ).toThrow("not included in this browser build");
  },
);
