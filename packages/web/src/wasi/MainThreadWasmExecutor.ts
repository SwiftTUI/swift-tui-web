import { ConsoleStdout, Fd, WASI, WASIProcExit, wasi } from "@bjorn3/browser_wasi_shim";

import { MainThreadInputQueue } from "./MainThreadInputQueue.ts";
import { SuspendingWasiPollScheduler } from "./WasiPollScheduler.ts";
import { jspiConstructors } from "./WasmEngineCapabilities.ts";

export interface MainThreadWasmExecutorOptions {
  wasmURL: string | URL;
  environment: Record<string, string>;
  onStdout(chunk: Uint8Array): void;
  onStderr(chunk: Uint8Array): void;
  onExit?(code: number): void;
  onError?(message: string): void;
}

/**
 * Runs a SwiftTUI WASI app on the main thread using WebAssembly JSPI: the
 * `poll_oneoff` import is wrapped in `WebAssembly.Suspending`, so the app's
 * run loop suspends to the browser event loop instead of blocking a worker
 * on `Atomics.wait`. Requires JSPI; needs neither a worker nor
 * SharedArrayBuffer (and therefore no COOP/COEP headers).
 *
 * Disposal closes stdin; the SwiftTUI runner exits cooperatively on stdin
 * hangup, which resolves the promised `_start` call.
 */
export class MainThreadWasmExecutor {
  private readonly options: MainThreadWasmExecutorOptions;
  private readonly stdin = new MainThreadInputQueue();
  private didStart = false;

  constructor(options: MainThreadWasmExecutorOptions) {
    this.options = options;
  }

  start(): void {
    if (this.didStart) {
      return;
    }
    this.didStart = true;
    void this.run();
  }

  sendInput(chunk: Uint8Array): void {
    this.stdin.write(chunk);
  }

  dispose(): void {
    this.stdin.close();
  }

  private async run(): Promise<void> {
    try {
      const jspi = jspiConstructors();
      if (!jspi) {
        throw new Error(
          "WebAssembly JSPI (Suspending/promising) is unavailable in this engine"
        );
      }

      const shim = new WASI(
        ["app.wasm"],
        Object.entries(this.options.environment).map(([key, value]) => `${key}=${value}`),
        [
          new MainThreadInputFileDescriptor(this.stdin),
          new ConsoleStdout((chunk) => this.options.onStdout(chunk)),
          new ConsoleStdout((chunk) => this.options.onStderr(chunk)),
        ]
      );

      const instanceExports = (): { memory?: WebAssembly.Memory } | undefined =>
        (shim as unknown as { inst?: { exports: { memory?: WebAssembly.Memory } } }).inst
          ?.exports;
      const originalPoll = shim.wasiImport.poll_oneoff as (
        inPtr: number,
        outPtr: number,
        nsubscriptions: number,
        neventsPtr?: number
      ) => number;
      const scheduler = new SuspendingWasiPollScheduler({
        memory: () => instanceExports()?.memory,
        stdin: this.stdin,
        fallbackPoll: (inPtr, outPtr, nsubscriptions, neventsPtr) =>
          originalPoll(inPtr, outPtr, nsubscriptions, neventsPtr),
      });

      const response = await fetch(this.options.wasmURL);
      if (!response.ok) {
        throw new Error(
          `failed to load ${String(this.options.wasmURL)}: ${response.status} ${response.statusText}`
        );
      }
      const module = await WebAssembly.compile(await response.arrayBuffer());
      const instance = await WebAssembly.instantiate(module, {
        wasi_snapshot_preview1: {
          ...shim.wasiImport,
          poll_oneoff: new jspi.Suspending(
            (inPtr: number, outPtr: number, nsubscriptions: number, neventsPtr: number) =>
              scheduler.pollOneOff(inPtr, outPtr, nsubscriptions, neventsPtr)
          ),
        },
      });
      (shim as unknown as { inst: WebAssembly.Instance }).inst =
        instance as WebAssembly.Instance;

      const start = jspi.promising(
        (instance as WebAssembly.Instance).exports._start
      );
      try {
        await start();
        this.options.onExit?.(0);
      } catch (error) {
        if (error instanceof WASIProcExit) {
          this.options.onExit?.(error.code);
          return;
        }
        throw error;
      }
    } catch (error) {
      this.options.onError?.(error instanceof Error ? error.message : String(error));
    }
  }
}

class MainThreadInputFileDescriptor extends Fd {
  private readonly queue: MainThreadInputQueue;
  private readonly fdstat = (() => {
    const fdstat = new wasi.Fdstat(wasi.FILETYPE_CHARACTER_DEVICE, 0);
    fdstat.fs_rights_base = BigInt(wasi.RIGHTS_FD_READ);
    return fdstat;
  })();

  constructor(queue: MainThreadInputQueue) {
    super();
    this.queue = queue;
  }

  override fd_fdstat_get(): { ret: number; fdstat: wasi.Fdstat } {
    return { ret: wasi.ERRNO_SUCCESS, fdstat: this.fdstat };
  }

  override fd_filestat_get(): { ret: number; filestat: wasi.Filestat } {
    return {
      ret: wasi.ERRNO_SUCCESS,
      filestat: new wasi.Filestat(0n, wasi.FILETYPE_CHARACTER_DEVICE, 0n),
    };
  }

  override fd_read(size: number): { ret: number; data: Uint8Array } {
    const chunk = this.queue.readAvailable(size);
    if (chunk) {
      return { ret: wasi.ERRNO_SUCCESS, data: chunk };
    }
    if (this.queue.isClosed()) {
      return { ret: wasi.ERRNO_SUCCESS, data: new Uint8Array() };
    }
    return { ret: wasi.ERRNO_AGAIN, data: new Uint8Array() };
  }
}
