export type NormalizedFocusSemantics =
  | "none"
  | "automatic"
  | "activate"
  | "edit";

export type NormalizedAccessibilityPoliteness =
  | "off"
  | "polite"
  | "assertive";

export type NormalizedSurfaceImageFormat = "png" | "jpeg" | "gif";
export type NormalizedSurfaceScalingMode = "stretch" | "fit" | "fill";

export function normalizeSemantics(
  value: string
): NormalizedFocusSemantics {
  switch (value) {
  case "none":
  case "automatic":
  case "activate":
  case "edit":
    return value;
  default:
    return "automatic";
  }
}

export function normalizePoliteness(
  value: string
): NormalizedAccessibilityPoliteness {
  switch (value) {
  case "off":
  case "polite":
  case "assertive":
    return value;
  default:
    return "polite";
  }
}

export function normalizeLiveRegion(
  value: string | undefined
): NormalizedAccessibilityPoliteness | undefined {
  switch (value) {
  case "off":
  case "polite":
  case "assertive":
    return value;
  default:
    return undefined;
  }
}

export function normalizeScalingMode(
  value: string
): NormalizedSurfaceScalingMode {
  switch (value) {
  case "stretch":
  case "fit":
  case "fill":
    return value;
  default:
    return "fit";
  }
}

export function isSupportedImageFormat(
  value: string
): value is NormalizedSurfaceImageFormat {
  return value === "png" || value === "jpeg" || value === "gif";
}
