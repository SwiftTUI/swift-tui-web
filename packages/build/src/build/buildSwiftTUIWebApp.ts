import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { type BuildAppWasmOptions, buildAppWasm } from "./buildAppWasm.ts";
import { parseWebRenderer, type WebRenderer } from "./buildBrowserBundle.ts";
import { copyDomFontAssets } from "./copyDomFontAssets.ts";
import { generateSceneManifest } from "./generateSceneManifest.ts";

export interface BuildSwiftTUIWebAppOptions extends BuildAppWasmOptions {
  appExecutable?: string;
  /** Include the experimental DOM font assets only when explicitly selected. */
  renderer?: WebRenderer;
}

export async function buildSwiftTUIWebApp(
  options: BuildSwiftTUIWebAppOptions,
): Promise<void> {
  const renderer = parseWebRenderer(options.renderer);
  await rm(options.outputDirectory, { recursive: true, force: true });
  await mkdir(options.outputDirectory, { recursive: true });
  await generateSceneManifest({
    packagePath: options.packagePath,
    outputPath: join(options.outputDirectory, "scene-manifest.json"),
    appExecutable: options.appExecutable ?? options.product,
    swiftCommand: options.swiftCommand,
  });
  await buildAppWasm(options);
  if (renderer === "dom") await copyDomFontAssets(options.outputDirectory);
}
