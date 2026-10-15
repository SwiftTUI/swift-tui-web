import { mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyDomFontAssets } from "./copyDomFontAssets.ts";
import { runCommand } from "./runCommand.ts";

export type WebRenderer = "canvas" | "dom";

export function parseWebRenderer(value: string = "canvas"): WebRenderer {
  if (value === "canvas" || value === "dom") return value;
  throw new Error(`unsupported web renderer: ${value}; expected canvas or dom`);
}

export interface BuildBrowserBundleOptions {
  outputDirectory: string;
  /** Canvas-only by default. DOM is experimental and explicitly packaged. */
  renderer?: WebRenderer;
}

/** Bundles a browser page with only the chosen painter. Requires Bun on PATH. */
export async function buildBrowserBundle(
  options: BuildBrowserBundleOptions,
): Promise<void> {
  const renderer = parseWebRenderer(options.renderer);
  const outputDirectory = resolve(options.outputDirectory);
  const entrypoint = fileURLToPath(
    import.meta.resolve("@swifttui/web/browser.html"),
  );
  await mkdir(outputDirectory, { recursive: true });
  // Remove previous generated presenters/fonts when switching renderers. Keep
  // the separately packaged scene manifest and WASM artifacts in this directory.
  for (const name of await readdir(outputDirectory)) {
    if (/^(?:index|browser)(?:[-.].*)?\.(?:js|css|html)$/.test(name)) {
      await rm(join(outputDirectory, name));
    }
  }
  await rm(join(outputDirectory, "assets/swifttui-fonts"), {
    recursive: true,
    force: true,
  });
  await runCommand([
    "bun",
    "build",
    entrypoint,
    "--outdir",
    outputDirectory,
    "--entry-naming",
    "index.[ext]",
    "--minify-syntax",
    "--define",
    `SWIFTTUI_WEB_RENDERER=${JSON.stringify(renderer)}`,
  ]);
  if (renderer === "dom") await copyDomFontAssets(outputDirectory);
}
