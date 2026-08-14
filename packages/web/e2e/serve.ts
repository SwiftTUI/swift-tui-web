import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { browserJourneyPort } from "./journey-environment.ts";

const e2eDirectory = import.meta.dir;
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const outputDirectory = join(repositoryRoot, ".build/browser-journey/site");

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

    const file =
      path === "/" || path === "/index.html"
        ? Bun.file(join(e2eDirectory, "fixture.html"))
        : path === "/preview-readiness.js"
          ? Bun.file(join(outputDirectory, "preview-readiness.js"))
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
