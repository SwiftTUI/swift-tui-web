import { defineConfig } from "tsdown";

// Browser runtime build. `unbundle` mirrors the source module structure 1:1 in
// `dist/`, which keeps `import.meta.url` worker resolution intact and preserves
// a single class identity across the `.` and `./wasi` entrypoints (a consumer
// importing `WebHostSceneRuntime` from the root and `createWasmSceneRuntimeFactory`
// from `./wasi` must observe the same class object).
export default defineConfig({
  entry: [
    "index.ts",
    "manifest.ts",
    "testing.ts",
    "wasi.ts",
    "wasi-worker.ts",
    "websocket.ts",
  ],
  format: "esm",
  platform: "neutral",
  dts: true,
  sourcemap: true,
  clean: true,
  unbundle: true,
  fixedExtension: false,
});
