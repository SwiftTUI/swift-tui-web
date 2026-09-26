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
  ["dom-surface.fixture.ts", "dom-surface.js"],
  ["dom-typography.fixture.ts", "dom-typography.js"],
  ["dom-geometry.fixture.ts", "dom-geometry.js"],
  ["geometry-corpus.fixture.ts", "geometry-corpus.js"],
  ["dom-fidelity.fixture.ts", "dom-fidelity.js"],
  ["font-qualification.fixture.ts", "font-qualification.js"],
  ["dom-performance.fixture.ts", "dom-performance.js"],
  ["accessibility-actions.fixture.ts", "accessibility-actions.js"],
  ["compiled-wasm-worker.ts", "compiled-wasm-worker.js"],
] as const) {
  const result = await Bun.build({
    entrypoints: [join(e2eDirectory, entry)],
    outdir: outputDirectory,
    target: "browser",
    format: "esm",
    naming: output,
    sourcemap: "external",
    minify: entry === "dom-performance.fixture.ts",
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

const paintBatchingBuild = await Bun.build({
  entrypoints: [join(e2eDirectory, "paint-batching.fixture.ts")],
  outdir: outputDirectory,
  target: "browser",
  format: "esm",
  naming: "paint-batching.js",
});
if (!paintBatchingBuild.success) {
  throw new Error("Could not build the paint-batching fixture.");
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
    const url = new URL(request.url);
    const path = url.pathname;
    const headers = url.searchParams.has("no-isolation") ? {} : responseHeaders;
    if (path === "/health") {
      return new Response("ok", { headers });
    }
    if (path === "/favicon.ico") {
      return new Response(null, { status: 204, headers });
    }
    if (
      /^\/fonts\/(SwiftTUICoreCandidate3-(Regular|Bold|Italic|BoldItalic)\.woff2|manifest\.json)$/.test(
        path,
      )
    ) {
      return new Response(
        Bun.file(join(repositoryRoot, "packages/web", path.slice(1))),
        { headers },
      );
    }

    if (/^\/assets\/swifttui-fonts\/[a-f0-9]+\/[a-zA-Z0-9_.-]+$/.test(path)) {
      return new Response(Bun.file(join(wasmDirectory, path.slice(1))), {
        headers,
      });
    }

    const wasmAssets: Record<string, string> = {
      "/font-qualification.js": join(outputDirectory, "font-qualification.js"),
      "/dom-performance.js": join(outputDirectory, "dom-performance.js"),
      "/dom-surface.js": join(outputDirectory, "dom-surface.js"),
      "/dom-typography.js": join(outputDirectory, "dom-typography.js"),
      "/dom-geometry.js": join(outputDirectory, "dom-geometry.js"),
      "/geometry-corpus.js": join(outputDirectory, "geometry-corpus.js"),
      "/dom-fidelity.js": join(outputDirectory, "dom-fidelity.js"),
      "/accessibility-actions.js": join(
        outputDirectory,
        "accessibility-actions.js",
      ),
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
            : path === "/paint-batching.js"
              ? Bun.file(join(outputDirectory, "paint-batching.js"))
              : path === "/style.css"
                ? Bun.file(join(repositoryRoot, "packages/web/style.css"))
                : undefined;
    if (!file) {
      return new Response("not found", {
        status: 404,
        headers,
      });
    }
    return new Response(file, {
      headers: {
        ...headers,
        "Content-Type": file.type,
      },
    });
  },
});

console.log(`SwiftTUI browser journey fixture: ${server.url}`);
