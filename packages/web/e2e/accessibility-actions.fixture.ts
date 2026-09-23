import {
  BrowserWASIBridge,
  type WebHostAccessibilityActionResponse,
  type WebHostAccessibilityNode,
  WebHostSceneRuntime,
} from "../dist/index.js";

const mount = document.createElement("div");
mount.style.cssText = "width:640px;height:400px";
document.body.appendChild(mount);
const records: string[] = [];
const bridge = new BrowserWASIBridge({
  sceneId: "actions",
  columns: 40,
  rows: 12,
});
bridge.stdin.subscribe((chunk) => {
  for (const record of new TextDecoder().decode(chunk).split("\n")) {
    if (record.startsWith("\u001eaccessibility:"))
      records.push(record.slice(1));
  }
});
const runtime = new WebHostSceneRuntime({
  mount,
  descriptor: { id: "actions", title: "Actions", isDefault: true },
  style: {},
  bridge,
  onInput: (chunk) => bridge.sendInput(chunk),
  paintScheduling: "synchronous",
});
await runtime.mount();
runtime.setVisible(true);
let sequence = 0;
const api = {
  records,
  present(
    nodes: WebHostAccessibilityNode[],
    response?: WebHostAccessibilityActionResponse,
  ) {
    bridge.stdout.write(
      new TextEncoder().encode(
        `\u001esurface:${JSON.stringify({
          version: 2,
          width: 40,
          height: 12,
          styles: [],
          rows: [],
          images: [],
          sequence: sequence++,
          accessibilityTree: nodes,
          accessibilityActionResponse: response,
        })}\n`,
      ),
    );
  },
};
Object.assign(window, { accessibilityActions: api });
