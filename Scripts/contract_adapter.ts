/** Public-kit NDJSON protocol adapter around the shipping decoder and request tracker.
 * The image map is the observer's retained payload set; real painters have their
 * own decode/cache/browser qualification. No expected observations are imported. */
import { AccessibilityRequests } from "../packages/web/src/AccessibilityRequests.ts";
import {
  encodeAccessibilityActionMessage,
  WebHostOutputDecoder,
  type WebHostSurfaceFrame,
} from "../packages/web/src/WebHostSurfaceTransport.ts";

let decoder = new WebHostOutputDecoder();
const requests = new AccessibilityRequests();
let frame: WebHostSurfaceFrame | undefined;
const images = new Set<string>();
let targets = new Set<string>();
const pending = new Set<bigint>();
let acknowledged: string[] = [];

function reset() {
  decoder = new WebHostOutputDecoder();
  requests.reset();
  frame = undefined;
  images.clear();
  targets.clear();
  pending.clear();
  acknowledged = [];
}

for (const line of (await Bun.stdin.text()).trim().split("\n")) {
  const operation = JSON.parse(line);
  const effects: unknown[] = [];
  switch (operation.op) {
    case "reset":
      reset();
      break;
    case "evictImage":
      images.delete(operation.id);
      decoder.requestImagePayloads([operation.id]);
      break;
    case "action":
      if (!targets.has(operation.target))
        effects.push({ error: "staleTarget" });
      else if (operation.action !== "activate")
        effects.push({ error: "unsupported" });
      else {
        const id = requests.issue(operation.target);
        pending.add(id);
        effects.push({
          input: new TextDecoder().decode(
            encodeAccessibilityActionMessage(
              operation.target,
              { action: "activate" },
              String(id),
            ),
          ),
        });
      }
      break;
    case "feed":
      for (const record of decoder.feed(Uint8Array.fromHex(operation.hex))) {
        if (record.type !== "surface") continue;
        const next = record.frame;
        if (frame && next.epoch !== frame.epoch) {
          requests.reset();
          pending.clear();
          acknowledged = [];
          images.clear();
        }
        decoder.prepareToPresentSurface(next);
        for (const image of next.images ?? [])
          if (image.dataBase64 !== undefined) images.add(image.id);
        targets = new Set(
          (next.accessibilityTree ?? []).flatMap((node) =>
            node.actionTarget ? [node.actionTarget] : [],
          ),
        );
        requests.retainTargets(targets);
        if (
          next.accessibilityActionResponse &&
          requests.settle(next.accessibilityActionResponse)
        ) {
          acknowledged.push(
            BigInt(next.accessibilityActionResponse.requestID).toString(),
          );
          acknowledged = acknowledged.slice(-256);
        }
        frame = next;
      }
      break;
    default:
      throw new Error(`unknown operation: ${operation.op}`);
  }
  for (const id of pending) if (!requests.has(id)) pending.delete(id);
  for (
    let resync = decoder.takeResyncRequest();
    resync;
    resync = decoder.takeResyncRequest()
  )
    effects.push({ resync });
  console.log(
    JSON.stringify({
      epoch: frame?.epoch ?? null,
      generation: frame?.gen ?? null,
      rows: frame
        ? Array.from({ length: frame.height }, (_, y) => frame!.rows[y] ?? [])
        : [],
      styles: frame?.styles ?? [],
      images: [...images].sort(),
      acknowledged,
      pending: [...pending].map(String).sort(),
      effects,
    }),
  );
}
