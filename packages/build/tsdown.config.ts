import { defineConfig } from "tsdown";

// Node CLI + build-tooling library. ESM output for Node; `cli.ts` keeps its
// `#!/usr/bin/env node` shebang (tsdown preserves it and marks dist/cli.js
// executable). `@swifttui/web` is a runtime dependency, so tsdown externalizes
// it automatically — it is consumed through its public entrypoints, not inlined.
export default defineConfig({
  entry: ["index.ts", "cli.ts"],
  format: "esm",
  platform: "node",
  dts: true,
  sourcemap: true,
  clean: true,
  unbundle: true,
  // type:module makes plain `.js` unambiguously ESM; keep extensions stable so
  // the published `bin`/`exports` paths (dist/cli.js, dist/index.js) match.
  fixedExtension: false,
});
