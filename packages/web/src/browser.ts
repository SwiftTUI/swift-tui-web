import { createWebHostApp, type WebHostTerminalStyle } from "./WebHostApp.ts";
import type { WebHostSurfaceRendererKind } from "./SurfaceRenderer.ts";

declare global {
  interface Window {
    __WEBTUI__?: {
      manifestUrl?: string;
      initialSceneId?: string;
      style?: WebHostTerminalStyle;
      renderer?: WebHostSurfaceRendererKind;
      embeddedHost?: {
        token?: string;
        webSocketBaseURL?: string;
      };
    };
    __WEBTUI_APP__?: Awaited<ReturnType<typeof createWebHostApp>>;
  }
}

async function bootstrap(): Promise<void> {
  const mount = document.getElementById("webhost-root");
  if (!mount) {
    throw new Error("webhost root element not found");
  }

  const config = window.__WEBTUI__ ?? {};
  const pageURL = new URL(globalThis.location?.href ?? import.meta.url);
  const embeddedToken = config.embeddedHost?.token ?? pageURL.searchParams.get("token") ?? undefined;
  const manifestUrl = tokenizedURL(
    config.manifestUrl ?? new URL("./scene-manifest.json", pageURL),
    embeddedToken
  );
  const controller = await createWebHostApp({
    mount,
    manifestUrl,
    initialSceneId: config.initialSceneId,
    style: config.style,
    renderer: config.renderer ?? rendererFromQuery(pageURL),
    embeddedHost: embeddedToken
      ? {
          token: embeddedToken,
          webSocketBaseURL: config.embeddedHost?.webSocketBaseURL ?? new URL("./", pageURL).href,
        }
      : undefined,
  });

  window.__WEBTUI_APP__ = controller;
}

void bootstrap();

// Allowlisted so a page URL can only choose a shipped presenter.
function rendererFromQuery(
  pageURL: URL
): WebHostSurfaceRendererKind | undefined {
  const renderer = pageURL.searchParams.get("renderer");
  return renderer === "dom" || renderer === "canvas" ? renderer : undefined;
}

function tokenizedURL(
  value: string | URL,
  token: string | undefined
): string | URL {
  if (!token) {
    return value;
  }
  const url = new URL(String(value), globalThis.location?.href ?? import.meta.url);
  url.searchParams.set("token", token);
  return url;
}
