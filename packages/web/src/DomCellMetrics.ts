import { fontForStyle } from "./CanvasSurfacePainter.ts";
import type { ResolvedWebHostTerminalStyle } from "./WebHostTerminalStyle.ts";

/** Measure layout in the actual styled mount, without selectable probe text. */
export function measureDomCells(
  mount: HTMLElement,
  style: ResolvedWebHostTerminalStyle,
): { width: number; height: number; advance: number } | undefined {
  const probe = document.createElement("span");
  probe.setAttribute("aria-hidden", "true");
  Object.assign(probe.style, {
    position: "absolute",
    visibility: "hidden",
    pointerEvents: "none",
    userSelect: "none",
    whiteSpace: "pre",
    font: fontForStyle(style),
    fontVariantLigatures: "none",
    letterSpacing: "0px",
    lineHeight: "normal",
  });
  probe.textContent = "W".repeat(64);
  mount.appendChild(probe);
  // Bounding geometry retains fractional advances. The ratio removes CSS zoom
  // or a scale transform; the runtime keeps cell dimensions in layout pixels.
  const rect = probe.getBoundingClientRect?.();
  const mountRect = mount.getBoundingClientRect?.();
  const scale =
    mount.offsetWidth > 0 && mountRect?.width
      ? mountRect.width / mount.offsetWidth
      : 1;
  probe.remove();
  if (!rect || rect.width <= 0 || rect.height <= 0) return undefined;
  const advance = rect.width / scale / 64;
  return {
    width: Math.max(1, Math.ceil(advance)),
    height: Math.max(1, Math.ceil(rect.height / scale)),
    advance,
  };
}
