/** User CSS overrides measured from the presented text, in CSS pixels. */
export interface DomTextSpacing {
  letterSpacing?: number;
  wordSpacing?: number;
  lineHeight?: number;
}

export function readDomTextSpacing(mount: HTMLElement): DomTextSpacing {
  const view = mount.ownerDocument?.defaultView;
  if (!view) return {};
  const text = mount.querySelector<HTMLElement>(
    ".webhost-scene__surface-row [data-column]",
  );
  const root =
    mount.querySelector<HTMLElement>(".webhost-scene__surface--dom") ??
    (mount.matches?.(".webhost-scene__surface--dom") ? mount : null);
  if (!text || !root) {
    const canvas = mount.querySelector<HTMLElement>(
      "canvas.webhost-scene__surface",
    );
    if (!canvas) return {};
    const computed = view.getComputedStyle(canvas);
    const spacing: DomTextSpacing = {};
    for (const key of ["letterSpacing", "wordSpacing", "lineHeight"] as const) {
      const value = Number.parseFloat(computed[key]);
      if (Number.isFinite(value) && value > 0) spacing[key] = value;
    }
    return spacing;
  }
  const computed = view.getComputedStyle(text);
  const result: DomTextSpacing = {};
  for (const key of ["letterSpacing", "wordSpacing", "lineHeight"] as const) {
    const authored =
      key === "lineHeight"
        ? Number.parseFloat(computed.fontSize) * 1.5
        : Number.parseFloat(text.style[key]) || 0;
    const actual = Number.parseFloat(computed[key]) || 0;
    if (Number.isFinite(actual) && Math.abs(actual - authored) > 1 / 64)
      result[key] = actual;
  }
  return result;
}
