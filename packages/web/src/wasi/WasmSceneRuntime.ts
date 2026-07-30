import {
  WebHostSceneRuntime,
  type WebHostSceneRuntimeOptions,
} from "../WebHostSceneRuntime.ts";
import {
  encodeResizeControlMessage,
  type BrowserWASIBridge,
} from "./BrowserWASIBridge.ts";

import { MainThreadWasmExecutor } from "./MainThreadWasmExecutor.ts";
import {
  SharedInputQueueWriter,
  createSharedInputQueue,
  type SharedInputQueueBuffers,
} from "./SharedInputQueue.ts";
import {
  mainThreadStackProfileEnvironmentDefaults,
  resolveWasmEngineCapabilities,
  type WasmEngineCapabilities,
} from "./WasmEngineCapabilities.ts";
import { createWasmPauseCell, setWasmPauseCellPaused } from "./WasmRuntimePause.ts";

const workerModuleURL = new URL("./wasm-scene-worker.js", import.meta.url);

interface WorkerStartMessage {
  type: "start";
  wasmURL: string;
  environment: Record<string, string>;
  inputQueue: SharedInputQueueBuffers;
  pauseCell?: SharedArrayBuffer;
}

interface WorkerOutputMessage {
  type: "stdout" | "stderr";
  chunk: Uint8Array;
}

interface WorkerExitMessage {
  type: "exit";
  code: number;
}

interface WorkerErrorMessage {
  type: "error";
  message: string;
}

type WorkerMessage = WorkerOutputMessage | WorkerExitMessage | WorkerErrorMessage;

export interface WasmSceneResizeEvent {
  sceneId: string;
  columns: number;
  rows: number;
  cellWidth?: number;
  cellHeight?: number;
}

export interface WasmSceneRuntimeHandle {
  readonly descriptor: WebHostSceneRuntime["descriptor"];
  sendInput(chunk: Uint8Array): void;
}

export type WasmExecutionMode = "worker" | "main-thread";
export type WasmExecutionModePreference = WasmExecutionMode | "auto";

export interface WasmSceneRuntimeFactoryOptions {
  onSceneResize?(event: WasmSceneResizeEvent): void;
  onRuntimeCreated?(runtime: WasmSceneRuntimeHandle): void;
  workerModuleURL?: string | URL;
  /**
   * How to execute the wasm app. "worker" is the classic path
   * (`Atomics.wait` stdin, needs SharedArrayBuffer/COOP/COEP). "main-thread"
   * runs on the page's thread via WebAssembly JSPI — larger stack budget (no
   * stack-lean profile on measured engines), no COOP/COEP requirement, at
   * the cost of sharing the main thread. "auto" (default) picks main-thread
   * only where workers cannot run (SharedArrayBuffer unavailable and JSPI
   * present); workers everywhere else.
   */
  executionMode?: WasmExecutionModePreference;
}

export function resolveWasmExecutionMode(
  preference: WasmExecutionModePreference,
  capabilities: WasmEngineCapabilities,
  sharedInputQueueAvailable: boolean
): WasmExecutionMode {
  if (preference !== "auto") {
    return preference;
  }
  if (!capabilities.supportsJSPI) {
    return "worker";
  }
  // Workers stay the auto default even on JSPI-capable engines: main-thread
  // execution shares the page's thread, and its stack-budget advantage only
  // pays off once the non-lean profile is production-ready (see
  // `stackProfileEnvironmentDefaults`). JSPI's auto role today is running
  // where workers cannot — pages without cross-origin isolation.
  if (!sharedInputQueueAvailable) {
    return "main-thread";
  }
  return "worker";
}

export function createWasmSceneRuntimeFactory(
  wasmURL: URL,
  factoryOptions: WasmSceneRuntimeFactoryOptions = {}
): (options: WebHostSceneRuntimeOptions) => WebHostSceneRuntime {
  return (options) => {
    const runtime = new WasmSceneRuntime(options, wasmURL, factoryOptions);
    factoryOptions.onRuntimeCreated?.(runtime);
    return runtime;
  };
}

class WasmSceneRuntime extends WebHostSceneRuntime {
  private readonly bridge?: BrowserWASIBridge;
  private readonly wasmURL: URL;
  private readonly onSceneResize?: (event: WasmSceneResizeEvent) => void;
  private readonly workerModuleURL: string | URL;
  private readonly executionModePreference: WasmExecutionModePreference;
  private readonly inputQueue?: SharedInputQueueBuffers;
  private readonly inputWriter?: SharedInputQueueWriter;
  private readonly inputRouter: { route(chunk: Uint8Array): boolean };
  private readonly inputCapacityNotifier: {
    disposed: boolean;
    pending: boolean;
  };
  private readonly sharedQueueError?: unknown;
  private readonly pauseCell?: SharedArrayBuffer;

  private detachBridgeInputListener?: () => void;
  private detachResizeListener?: () => void;
  private worker?: Worker;
  private executor?: MainThreadWasmExecutor;
  private didMount = false;
  private suspended = false;

  constructor(
    options: WebHostSceneRuntimeOptions,
    wasmURL: URL,
    factoryOptions: WasmSceneRuntimeFactoryOptions
  ) {
    let inputQueue: SharedInputQueueBuffers | undefined;
    let inputWriter: SharedInputQueueWriter | undefined;
    let sharedQueueError: unknown;
    let pauseCell: SharedArrayBuffer | undefined;
    const inputCapacityNotifier = {
      disposed: false,
      pending: false,
    };

    try {
      inputQueue = createSharedInputQueue();
      inputWriter = new SharedInputQueueWriter(inputQueue);
      pauseCell = createWasmPauseCell();
    } catch (error) {
      // Not fatal here: the main-thread (JSPI) mode runs without
      // SharedArrayBuffer. Surfaced at mount if the worker mode needs it.
      sharedQueueError = error;
    }

    // Input is streamed rather than all-or-nothing. A single ring write can
    // only enqueue what currently fits, so a paste larger than the free space
    // used to fail outright and drop the whole clipboard; `writeAsync` takes
    // `min(free, remaining)` bytes at a time and awaits the reader in between,
    // bounded by a 500 ms deadline. It never blocks — this is the main thread.
    // Assigned right after `super()`: `this` is unavailable until then, and the
    // reporter is only ever invoked from a settled promise afterwards.
    const overflowReporter: {
      report?: (bytesWritten: number, bytesRemaining: number) => void;
    } = {};

    const enqueueInput = (
      writer: SharedInputQueueWriter,
      chunk: Uint8Array
    ): void => {
      void writer.writeAsync(chunk).then((outcome) => {
        if (inputCapacityNotifier.disposed || outcome.status === "written") {
          return;
        }
        if (outcome.status === "closed") {
          return;
        }
        // Only a write that ran out of budget is reportable, and it is
        // reportable *into the app's mount*: silently losing the tail of a
        // paste is exactly the failure this stage exists to remove, so it must
        // not be console-only.
        overflowReporter.report?.(outcome.bytesWritten, outcome.bytesRemaining);
      });
      if (!inputCapacityNotifier.pending) {
        inputCapacityNotifier.pending = true;
        void writer.waitForCapacity(1).then((available) => {
          inputCapacityNotifier.pending = false;
          if (available && !inputCapacityNotifier.disposed) {
            (options.bridge as BrowserWASIBridge | undefined)
              ?.notifyInputCapacityAvailable();
          }
        });
      }
    };

    const inputRouter = {
      route: (chunk: Uint8Array): boolean => {
        if (!inputWriter) {
          return false;
        }
        enqueueInput(inputWriter, chunk);
        return true;
      },
    };

    super({
      ...options,
      onInput: (chunk) => inputRouter.route(chunk),
    });
    overflowReporter.report = (bytesWritten, bytesRemaining) => {
      this.notifyInputOverflow(bytesWritten, bytesRemaining);
    };

    this.bridge = options.bridge;
    this.wasmURL = wasmURL;
    this.onSceneResize = factoryOptions.onSceneResize;
    this.workerModuleURL = factoryOptions.workerModuleURL ?? workerModuleURL;
    this.executionModePreference = factoryOptions.executionMode ?? "auto";
    this.inputQueue = inputQueue;
    this.inputWriter = inputWriter;
    this.inputRouter = inputRouter;
    this.inputCapacityNotifier = inputCapacityNotifier;
    this.sharedQueueError = sharedQueueError;
    this.pauseCell = pauseCell;
  }

  /// Reports a logical input write that ran out of its deadline.
  ///
  /// Surfaced as a runtime issue rather than a console message: the tail of a
  /// paste going missing is a user-visible data loss, and the whole point of
  /// the chunked writer is that it should not happen silently.
  private notifyInputOverflow(
    bytesWritten: number,
    bytesRemaining: number
  ): void {
    const message = bytesWritten === 0
      ? `Dropped ${bytesRemaining} byte(s) of terminal input: the app did not read from its input queue within 500 ms.`
      : `Delivered ${bytesWritten} byte(s) of terminal input and dropped ${bytesRemaining}: the app did not drain its input queue within 500 ms.`;
    this.notifyRuntimeIssue({
      severity: "warning",
      code: "web.input.queueDeadlineExceeded",
      message,
      description: `SwiftTUI runtime warning [web.input.queueDeadlineExceeded] ${message}`,
      source: "web-host",
    });
  }

  protected override onRuntimeSuspensionChange(
    suspended: boolean
  ): void {
    this.suspended = suspended;
    if (this.pauseCell) {
      setWasmPauseCellPaused(this.pauseCell, suspended);
    }
    this.executor?.setSuspended(suspended);
  }

  override async mount(): Promise<void> {
    await super.mount();
    if (this.didMount) {
      return;
    }

    this.didMount = true;
    this.detachBridgeInputListener = this.bridge?.stdin.subscribe((chunk) => {
      return this.inputRouter.route(chunk);
    });
    this.detachResizeListener = this.bridge?.subscribeResize((columns, rows, cellWidth, cellHeight) => {
      this.onSceneResize?.({
        sceneId: this.descriptor.id,
        columns,
        rows,
        cellWidth,
        cellHeight,
      });
    });

    const initialColumns = Number(this.bridge?.environment.SWIFTTUI_COLUMNS ?? "0") || 0;
    const initialRows = Number(this.bridge?.environment.SWIFTTUI_ROWS ?? "0") || 0;
    if (!this.bridge && initialColumns > 0 && initialRows > 0) {
      this.onSceneResize?.({
        sceneId: this.descriptor.id,
        columns: initialColumns,
        rows: initialRows,
      });
    }

    if (!this.bridge) {
      this.writeOutput(
        "\r\nSwiftTUI WASI browser runtime requires a WASI bridge.\r\n"
      );
      return;
    }

    const mode = resolveWasmExecutionMode(
      this.executionModePreference,
      resolveWasmEngineCapabilities(),
      this.inputQueue !== undefined && this.inputWriter !== undefined
    );
    if (mode === "main-thread") {
      this.startMainThreadExecutor();
      return;
    }

    if (!this.inputQueue || !this.inputWriter) {
      if (this.sharedQueueError !== undefined) {
        console.error(
          "[SwiftTUIWeb] failed to create shared stdin queue",
          this.sharedQueueError
        );
      }
      this.writeOutput(
        "\r\nSwiftTUI WASI browser runtime requires SharedArrayBuffer-backed stdin. Serve the app with COOP/COEP headers.\r\n"
      );
      return;
    }

    this.worker = new Worker(this.workerModuleURL, { type: "module" });
    this.worker.addEventListener("message", (event: MessageEvent<WorkerMessage>) => {
      this.handleWorkerMessage(event.data);
    });
    this.worker.addEventListener("error", (event) => {
      this.bridge?.stderr.write(
        `\nSwiftTUI WASI worker failed: ${event.message || "unknown worker error"}\n`
      );
    });

    const environment = { ...this.bridge.environment };

    const message: WorkerStartMessage = {
      type: "start",
      wasmURL: this.wasmURL.href,
      environment,
      inputQueue: this.inputQueue,
      pauseCell: this.pauseCell,
    };
    this.worker.postMessage(message);
  }

  override dispose(): void {
    this.inputCapacityNotifier.disposed = true;
    this.detachBridgeInputListener?.();
    this.detachResizeListener?.();
    this.inputWriter?.close();
    this.worker?.terminate();
    this.executor?.dispose();
    super.dispose();
  }

  private startMainThreadExecutor(): void {
    const bridge = this.bridge;
    if (!bridge) {
      return;
    }
    const executor = new MainThreadWasmExecutor({
      wasmURL: this.wasmURL.href,
      environment: {
        ...mainThreadStackProfileEnvironmentDefaults(resolveWasmEngineCapabilities()),
        ...bridge.environment,
      },
      onStdout: (chunk) => bridge.stdout.write(chunk),
      onStderr: (chunk) => bridge.stderr.write(chunk),
      onExit: (code) => {
        if (code !== 0) {
          bridge.stderr.write(`\nSwiftTUI WASI app exited with code ${code}.\n`);
        }
      },
      onError: (message) => {
        bridge.stderr.write(`\nFailed to start SwiftTUI WASI app: ${message}\n`);
      },
    });
    this.executor = executor;
    this.inputRouter.route = (chunk) => {
      executor.sendInput(chunk);
      return true;
    };
    executor.setSuspended(this.suspended);
    executor.start();
  }

  private handleWorkerMessage(
    message: WorkerMessage
  ): void {
    switch (message.type) {
    case "stdout":
      this.bridge?.stdout.write(message.chunk);
      break;
    case "stderr":
      this.bridge?.stderr.write(message.chunk);
      break;
    case "exit":
      if (message.code !== 0) {
        this.bridge?.stderr.write(`\nSwiftTUI WASI app exited with code ${message.code}.\n`);
      }
      break;
    case "error":
      this.bridge?.stderr.write(`\nFailed to start SwiftTUI WASI app: ${message.message}\n`);
      break;
    }
  }
}
