import type { WebHostAccessibilityPreferences } from "./WebHostTerminalStyle.ts";

const storageKey = "swifttui.accessibility.preferences.v1";
const profiles = [
  "standard",
  "monochrome",
  "protanopia",
  "deuteranopia",
  "tritanopia",
] as const;
const booleanKeys = [
  "reduceMotion",
  "differentiateWithoutColor",
  "reduceTransparency",
] as const;

/** Preferences are scoped to this tab and origin; no connection credentials are stored. */
export function readWebHostAccessibilityPreferences(): WebHostAccessibilityPreferences {
  try {
    const value: unknown = JSON.parse(
      globalThis.sessionStorage?.getItem(storageKey) ?? "{}",
    );
    if (!value || typeof value !== "object") return {};
    const result: WebHostAccessibilityPreferences = {};
    for (const key of booleanKeys) {
      const candidate = (value as Record<string, unknown>)[key];
      if (typeof candidate === "boolean") result[key] = candidate;
    }
    const contrast = (value as Record<string, unknown>).contrast;
    if (contrast === "standard" || contrast === "increased")
      result.contrast = contrast;
    const profile = (value as Record<string, unknown>).colorProfile;
    if (profiles.some((candidate) => candidate === profile))
      result.colorProfile = profile as (typeof profiles)[number];
    return result;
  } catch {
    return {};
  }
}

export function createWebHostAccessibilitySettings(
  document: Document,
  initial: WebHostAccessibilityPreferences,
  changed: (preferences: WebHostAccessibilityPreferences) => void,
): {
  element: HTMLElement;
  update(preferences: WebHostAccessibilityPreferences): void;
} {
  const details = document.createElement("details");
  details.className = "webhost-accessibility-settings";
  Object.assign(details.style, {
    flex: "0 0 auto",
    color: "CanvasText",
    background: "Canvas",
    font: "14px system-ui",
    padding: "4px 8px",
    boxSizing: "border-box",
  });
  const summary = document.createElement("summary");
  summary.textContent = "Accessibility settings";
  details.append(summary);
  const fields = document.createElement("div");
  Object.assign(fields.style, {
    display: "flex",
    flexWrap: "wrap",
    gap: "8px",
    padding: "8px 0",
  });
  details.append(fields);
  const selectors = new Map<
    keyof WebHostAccessibilityPreferences,
    HTMLSelectElement
  >();
  const definitions: [
    keyof WebHostAccessibilityPreferences,
    string,
    readonly string[],
  ][] = [
    ["reduceMotion", "Reduce motion", ["auto", "on", "off"]],
    ["contrast", "Contrast", ["auto", "increased", "standard"]],
    [
      "differentiateWithoutColor",
      "Differentiate without color",
      ["auto", "on", "off"],
    ],
    ["reduceTransparency", "Reduce transparency", ["auto", "on", "off"]],
    ["colorProfile", "Color profile", ["auto", ...profiles]],
  ];
  const read = (): WebHostAccessibilityPreferences => {
    const result: WebHostAccessibilityPreferences = {};
    for (const key of booleanKeys) {
      const value = selectors.get(key)?.value ?? "auto";
      result[key] = value === "auto" ? undefined : value === "on";
    }
    const contrast = selectors.get("contrast")?.value ?? "auto";
    result.contrast =
      contrast === "auto" ? undefined : (contrast as "standard" | "increased");
    const profile = selectors.get("colorProfile")?.value ?? "auto";
    result.colorProfile =
      profile === "auto" ? undefined : (profile as (typeof profiles)[number]);
    return result;
  };
  const commit = () => {
    const preferences = read();
    try {
      globalThis.sessionStorage?.setItem(
        storageKey,
        JSON.stringify(preferences),
      );
    } catch {}
    changed(preferences);
  };
  for (const [key, title, values] of definitions) {
    const label = document.createElement("label");
    label.append(document.createTextNode(`${title} `));
    const select = document.createElement("select");
    for (const value of values) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent =
        value === "auto"
          ? "Use system setting"
          : value.charAt(0).toUpperCase() + value.slice(1);
      select.append(option);
    }
    select.addEventListener("change", commit);
    selectors.set(key, select);
    label.append(select);
    fields.append(label);
  }
  const reset = document.createElement("button");
  reset.type = "button";
  reset.textContent = "Use system settings";
  reset.addEventListener("click", () => {
    for (const select of selectors.values()) select.value = "auto";
    commit();
  });
  fields.append(reset);
  const update = (preferences: WebHostAccessibilityPreferences) => {
    for (const [key, select] of selectors) {
      const value = preferences[key];
      select.value =
        value === undefined
          ? "auto"
          : typeof value === "boolean"
            ? value
              ? "on"
              : "off"
            : value;
    }
  };
  update(initial);
  return { element: details, update };
}
