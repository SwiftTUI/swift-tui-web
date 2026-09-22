import { fileURLToPath } from "node:url";
import { buildSwiftTUIWebApp } from "../../build/dist/index.js";

// Public build entry point, with a checked-in app and exact HTTPS dependency.
// No org checkout, source overlays, or independently authored Swift flags.
await buildSwiftTUIWebApp({
  packagePath: fileURLToPath(
    new URL("../../../Fixtures/BrowserApp", import.meta.url),
  ),
  outputDirectory: fileURLToPath(
    new URL("../../../.build/browser-journey/wasm", import.meta.url),
  ),
  product: "BrowserApp",
});
