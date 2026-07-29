import type {
  CanvasSurfacePainterOptions,
} from "../dist/testing.js";
import type {
  DomSurfacePainterOptions,
  WebHostSceneBridge,
  WebHostImagePayloadRequestHandler,
} from "../dist/index.js";

const requests: string[][] = [];

const legacyHandler: WebHostImagePayloadRequestHandler =
  (ids) => requests.push([...ids]);

const admissionAwareHandler: WebHostImagePayloadRequestHandler =
  (ids) => ids.filter((id) => id.startsWith("png:"));

const canvasOptions: CanvasSurfacePainterOptions = {
  onImagePayloadMiss: (ids) => requests.push([...ids]),
};

const legacyCanvasDecodeOptions: CanvasSurfacePainterOptions = {
  decodeImage: async (_payload, _format) => ({} as CanvasImageSource),
};

const IDAwareCanvasDecodeOptions: CanvasSurfacePainterOptions = {
  decodeImage: async (_payload, _format, _imageID) => ({} as CanvasImageSource),
};

const domOptions: DomSurfacePainterOptions = {
  onImagePayloadMiss: (ids) => requests.push([...ids]),
};

const bridgeHandler: NonNullable<WebHostSceneBridge["requestImagePayloads"]> =
  (ids) => requests.push([...ids]);

type IsExact<Actual, Expected> =
  [Actual] extends [Expected]
    ? [Expected] extends [Actual]
      ? true
      : false
    : false;

type Assert<Condition extends true> = Condition;

type ImagePayloadRequestResult =
  ReturnType<WebHostImagePayloadRequestHandler>;

type PreservesAdmissionResult = Assert<
  IsExact<ImagePayloadRequestResult, readonly string[] | void>
>;

function requestImagePayloads(
  handler: WebHostImagePayloadRequestHandler
): readonly string[] | void {
  const result = handler(["png:accepted", "jpeg:rejected"]);
  if (result === undefined) {
    return;
  }
  const admittedIds: readonly string[] = result;
  return admittedIds;
}

void [
  legacyHandler,
  admissionAwareHandler,
  canvasOptions,
  legacyCanvasDecodeOptions,
  IDAwareCanvasDecodeOptions,
  domOptions,
  bridgeHandler,
  requestImagePayloads,
];
