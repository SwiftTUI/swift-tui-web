import { readFileSync } from "node:fs";

/**
 * Real `web-surface` records for duplicate accessibility siblings (STUI-1259),
 * keyed by the step that produced each one.
 *
 * Recorded from tagged SwiftTUI 0.19.5 through its public
 * `AndroidHostSceneHost`, whose records come from the same
 * `WebSurfaceFrameEncoder` the WASI browser bridge uses. The `buttons` scene is
 * `Button("Hide first")` followed by
 * `ForEach(["Same", "Same"].enumerated(), id: \.element) { Button($0.element) {} }`,
 * whose first `Same` is `accessibilityHidden` once "Hide first" is activated;
 * each step is one key (Tab or Return). The `text` scene is
 * `ForEach(["Same", "Same"], id: \.self) { Text($0) }`. Both duplicates carry
 * the same occurrence-free `id`; the buttons carry distinct `actionTarget`s.
 * The file holds `# <scene>: <step>` lines, each followed by its record.
 */
export function duplicateAccessibilityFrames(): Map<string, string> {
  const text = readFileSync(
    new URL("./duplicate-accessibility-siblings.frames.txt", import.meta.url),
    "utf8",
  );
  const frames = new Map<string, string>();
  let label: string | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("# ")) {
      label = line.slice(2);
    } else if (line && label) {
      frames.set(label, `${line}\n`);
      label = undefined;
    }
  }
  return frames;
}
