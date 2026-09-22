import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { browserJourneyPort } from "./journey-environment.ts";

const e2eDirectory = import.meta.dir;
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const outputDirectory = join(repositoryRoot, ".build/browser-journey/site");
const wasmDirectory = join(repositoryRoot, ".build/browser-journey/wasm");

for (const asset of ["assets/app.wasm", "scene-manifest.json"]) {
  if (!(await Bun.file(join(wasmDirectory, asset)).exists())) {
    throw new Error(
      `Missing compiled WASM fixture (${asset}). Run bun run build:browser-fixture first.`,
    );
  }
}

for (const [entry, output] of [
  ["compiled-wasm.fixture.ts", "compiled-wasm.js"],
  ["compiled-wasm-worker.ts", "compiled-wasm-worker.js"],
] as const) {
  const result = await Bun.build({
    entrypoints: [join(e2eDirectory, entry)],
    outdir: outputDirectory,
    target: "browser",
    format: "esm",
    naming: output,
    sourcemap: "external",
  });
  if (!result.success)
    throw new AggregateError(result.logs, `Could not build ${entry}`);
}

const build = await Bun.build({
  entrypoints: [join(e2eDirectory, "preview-readiness.fixture.ts")],
  outdir: outputDirectory,
  target: "browser",
  format: "esm",
  sourcemap: "external",
  naming: "preview-readiness.js",
});

if (!build.success) {
  for (const log of build.logs) {
    console.error(log);
  }
  throw new Error("Could not build the browser preview-readiness fixture.");
}

const damageBuild = await Bun.build({
  entrypoints: [join(e2eDirectory, "canvas-damage.fixture.ts")],
  outdir: outputDirectory,
  target: "browser",
  format: "esm",
  naming: "canvas-damage.js",
});
if (!damageBuild.success) {
  throw new Error("Could not build the Canvas damage fixture.");
}

const responseHeaders = {
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: browserJourneyPort,
  fetch(request): Response {
    const path = new URL(request.url).pathname;
    if (path === "/health") {
      return new Response("ok", { headers: responseHeaders });
    }
    if (path === "/favicon.ico") {
      return new Response(null, { status: 204, headers: responseHeaders });
    }

    const wasmAssets: Record<string, string> = {
      "/compiled-wasm.html": join(e2eDirectory, "compiled-wasm.html"),
      "/compiled-wasm.js": join(outputDirectory, "compiled-wasm.js"),
      "/compiled-wasm.js.map": join(outputDirectory, "compiled-wasm.js.map"),
      "/compiled-wasm-worker.js": join(
        outputDirectory,
        "compiled-wasm-worker.js",
      ),
      "/compiled-wasm-worker.js.map": join(
        outputDirectory,
        "compiled-wasm-worker.js.map",
      ),
      "/app.wasm": join(wasmDirectory, "assets/app.wasm"),
      "/scene-manifest.json": join(wasmDirectory, "scene-manifest.json"),
    };
    const file = wasmAssets[path]
      ? Bun.file(wasmAssets[path])
      : path === "/" || path === "/index.html"
        ? Bun.file(join(e2eDirectory, "fixture.html"))
        : path === "/preview-readiness.js"
          ? Bun.file(join(outputDirectory, "preview-readiness.js"))
          : path === "/canvas-damage.js"
            ? Bun.file(join(outputDirectory, "canvas-damage.js"))
            : path === "/style.css"
              ? Bun.file(join(repositoryRoot, "packages/web/style.css"))
              : undefined;
    if (!file) {
      return new Response("not found", {
        status: 404,
        headers: responseHeaders,
      });
    }
    return new Response(file, {
      headers: {
        ...responseHeaders,
        "Content-Type": file.type,
      },
    });
  },
});

console.log(`SwiftTUI browser journey fixture: ${server.url}`);
