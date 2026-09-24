import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOM_FONT_ASSET_PATH } from "@swifttui/web";

/** Copies the font bytes and licensing from the installed runtime package. */
export async function copyDomFontAssets(
  outputDirectory: string,
): Promise<{ assetPath: string }> {
  const root = dirname(
    fileURLToPath(import.meta.resolve("@swifttui/web/package.json")),
  );
  const manifestBytes = await readFile(join(root, "fonts/manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString()) as {
    faces: { file: string; sha256: string }[];
    licenseSha256: string;
  };
  const destination = join(outputDirectory, DOM_FONT_ASSET_PATH);
  await mkdir(destination, { recursive: true });
  for (const asset of [
    ...manifest.faces,
    { file: "LICENSE.md", sha256: manifest.licenseSha256 },
  ]) {
    if (asset.file !== asset.file.split(/[\\/]/).at(-1))
      throw new Error("Invalid font asset name");
    const source = join(root, "fonts", asset.file);
    const bytes = await readFile(source);
    if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
      throw new Error(`DOM font asset hash mismatch: ${asset.file}`);
    await copyFile(source, join(destination, asset.file));
  }
  await copyFile(
    join(root, "fonts/manifest.json"),
    join(destination, "manifest.json"),
  );
  return { assetPath: DOM_FONT_ASSET_PATH };
}
