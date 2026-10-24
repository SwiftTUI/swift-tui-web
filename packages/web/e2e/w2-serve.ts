// Standalone fixture server for the campaign-two W2 browser journeys.
//
// Deliberately separate from `serve.ts`: the W2 lineage drives the real
// painters through a synthetic transport peer and needs neither the compiled
// Swift WASM fixture (which `serve.ts` requires at startup) nor port 4173
// (held by the organization browser gate while this lineage runs). It serves
// the built public package, the packaged DOM fonts, the stylesheet and the W2
// driver fixture with the same cross-origin isolation headers.

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import fontManifest from "../fonts/manifest.json" with { type: "json" };

const e2eDirectory = import.meta.dir;
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const outputDirectory = join(repositoryRoot, ".build/w2-journey/site");

const configuredPort = process.env.SWIFTTUI_BROWSER_JOURNEY_PORT;
const port =
  configuredPort === undefined ? 4273 : Number.parseInt(configuredPort, 10);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(
    `SWIFTTUI_BROWSER_JOURNEY_PORT must be an integer from 1 through 65535; received ${configuredPort}.`,
  );
}

const fontPaths = new Set([
  ...fontManifest.faces.map((face) => `/fonts/${face.file}`),
  "/fonts/manifest.json",
]);

const build = await Bun.build({
  entrypoints: [join(e2eDirectory, "w2-adversarial.fixture.ts")],
  outdir: outputDirectory,
  target: "browser",
  format: "esm",
  naming: "w2-adversarial.js",
  sourcemap: "external",
});
if (!build.success)
  throw new AggregateError(build.logs, "Could not build the W2 fixture.");

const isolationHeaders = {
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
};

const fixtureHtml = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>SwiftTUI W2 adversarial journeys</title>
    <link rel="stylesheet" href="/style.css">
    <style>html,body{margin:0;background:#0f172a}</style>
  </head>
  <body><main id="journey-root"></main></body>
</html>
`;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(request): Response {
    const path = new URL(request.url).pathname;
    const headers: Record<string, string> = { ...isolationHeaders };
    if (path === "/health") return new Response("ok", { headers });
    if (path === "/favicon.ico")
      return new Response(null, { status: 204, headers });
    if (path === "/" || path === "/index.html")
      return new Response(fixtureHtml, {
        headers: { ...headers, "Content-Type": "text/html" },
      });
    if (path === "/style.css")
      return new Response(Bun.file(join(packageRoot, "style.css")), {
        headers,
      });
    if (fontPaths.has(path))
      return new Response(Bun.file(join(packageRoot, path.slice(1))), {
        headers,
      });
    if (path === "/w2-adversarial.js" || path === "/w2-adversarial.js.map")
      return new Response(Bun.file(join(outputDirectory, path.slice(1))), {
        headers,
      });
    return new Response("not found", { status: 404, headers });
  },
});

console.log(`SwiftTUI W2 journey fixture: ${server.url}`);
