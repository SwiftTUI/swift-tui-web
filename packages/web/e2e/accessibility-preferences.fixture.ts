import {
  createWebHostApp,
  resolveWebHostTerminalRenderStyle,
  type WebHostTerminalRenderStyle,
} from "../dist/index.js";

const mount = document.createElement("div");
mount.style.cssText = "width:720px;height:540px";
document.body.append(mount);
const styles: Record<string, WebHostTerminalRenderStyle> = {};
const inputs: number[] = [];
const controller = await createWebHostApp({
  mount,
  renderer:
    new URLSearchParams(location.search).get("renderer") === "dom"
      ? "dom"
      : "canvas",
  manifest: {
    defaultSceneId: "alpha",
    scenes: [
      { id: "alpha", title: "Alpha", isDefault: true },
      { id: "beta", title: "Beta", isDefault: false },
    ],
  },
  bridgeFactory: ({ sceneId, style }) => {
    styles[sceneId] = resolveWebHostTerminalRenderStyle(style);
    return {
      bindOutput() {},
      resize() {},
      dispose() {},
      sendInput(chunk) {
        inputs.push(chunk.length);
      },
      updateRenderStyle(value) {
        styles[sceneId] = resolveWebHostTerminalRenderStyle(value);
      },
    };
  },
});
const api = {
  styles,
  inputs,
  switchScene: (id: string) => controller.switchScene(id),
  dispose: () => controller.dispose(),
};
Object.assign(window, { __accessibilityPreferences: api });
declare global {
  interface Window {
    __accessibilityPreferences: typeof api;
  }
}
