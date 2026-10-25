import { expect, test } from "bun:test";
import { MainThreadInputQueue } from "./MainThreadInputQueue.ts";
import { StdIOPipe } from "./StdIOPipe.ts";

const bytes = (...values: number[]) => new Uint8Array(values);
const array = (value: Uint8Array | undefined) =>
  value === undefined ? undefined : [...value];

for (let id = 131; id <= 144; id++) {
  test(`w1s${id} WASI pipe ownership contract`, async () => {
    const pipe = new StdIOPipe();
    const observed: number[][] = [];
    let detach: (() => void) | undefined;
    try {
      switch (id) {
        case 131:
          pipe.write(bytes(1, 2));
          pipe.write(bytes(3));
          expect(array(await pipe.read())).toEqual([1, 2]);
          expect(array(await pipe.read())).toEqual([3]);
          expect(pipe.bufferedBytes).toBe(0);
          break;
        case 132: {
          const source = bytes(1, 2);
          pipe.write(source);
          source[0] = 9;
          expect(array(await pipe.read())).toEqual([1, 2]);
          break;
        }
        case 133: {
          const pending = pipe.read();
          pipe.write(bytes(1, 2));
          expect(array(await pending)).toEqual([1, 2]);
          break;
        }
        case 134: {
          const first = pipe.read(),
            second = pipe.read();
          pipe.write(bytes(1));
          pipe.write(bytes(2));
          expect((await Promise.all([first, second])).map(array)).toEqual([
            [1],
            [2],
          ]);
          break;
        }
        case 135:
          pipe.write(bytes(1));
          pipe.close();
          expect(array(await pipe.read())).toEqual([1]);
          expect(await pipe.read()).toBeUndefined();
          break;
        case 136: {
          const first = pipe.read(),
            second = pipe.read();
          pipe.close();
          expect(await Promise.all([first, second])).toEqual([
            undefined,
            undefined,
          ]);
          break;
        }
        case 137:
          pipe.close();
          pipe.close();
          expect(pipe.write(bytes(1))).toBe(false);
          expect(pipe.bufferedBytes).toBe(0);
          expect(await pipe.read()).toBeUndefined();
          break;
        case 138: {
          detach = pipe.subscribe((chunk) => {
            observed.push([...chunk]);
          });
          pipe.write(bytes(1));
          expect(array(await pipe.read())).toEqual([1]);
          const pending = pipe.read();
          pipe.write(bytes(2));
          expect(array(await pending)).toEqual([2]);
          // STUI-1181 (fixed in wave 2): the write that satisfied the pending
          // read is still observed.
          expect(observed).toEqual([[1], [2]]);
          break;
        }
        case 139:
          detach = pipe.subscribe((chunk) => {
            observed.push([...chunk]);
          });
          pipe.write(bytes(1));
          detach();
          pipe.write(bytes(2));
          expect(observed).toEqual([[1]]);
          expect(array(await pipe.read())).toEqual([1]);
          expect(array(await pipe.read())).toEqual([2]);
          break;
        case 140:
          pipe.write(bytes(1));
          pipe.write(bytes(2));
          detach = pipe.consume((chunk) => {
            observed.push([...chunk]);
          });
          expect(observed).toEqual([[1], [2]]);
          expect(pipe.bufferedBytes).toBe(0);
          break;
        case 141:
          detach = pipe.consume(() => {});
          expect(() => pipe.consume(() => {})).toThrow();
          await expect(pipe.read()).rejects.toThrow();
          break;
        case 142: {
          const pending = pipe.read();
          try {
            expect(() => pipe.consume(() => {})).toThrow();
          } finally {
            pipe.close();
            await pending;
          }
          break;
        }
        case 143:
          detach = pipe.consume((chunk) => {
            observed.push([...chunk]);
          });
          pipe.write(bytes(1));
          detach();
          pipe.write(bytes(2));
          expect(observed).toEqual([[1]]);
          expect(array(await pipe.read())).toEqual([2]);
          break;
        case 144:
          detach = pipe.consume(() => false);
          expect(pipe.write(bytes(1))).toBe(false);
          expect(pipe.bufferedBytes).toBe(0);
          break;
      }
    } finally {
      detach?.();
      pipe.close();
    }
  });
}

for (let id = 145; id <= 150; id++) {
  test(`w1s${id} WASI queue readiness contract`, async () => {
    const queue = new MainThreadInputQueue();
    try {
      switch (id) {
        case 145: {
          const pending = queue.waitForReadableAsync();
          queue.write(bytes(1));
          expect(await pending).toBe("readable");
          expect(array(queue.readAvailable(8))).toEqual([1]);
          break;
        }
        case 146: {
          const first = queue.waitForReadableAsync(),
            second = queue.waitForReadableAsync();
          queue.write(bytes(1));
          expect(await Promise.all([first, second])).toEqual([
            "readable",
            "readable",
          ]);
          break;
        }
        case 147:
          queue.write(bytes(1, 2, 3, 4));
          expect(queue.availableBytes()).toBe(4);
          expect(array(queue.readAvailable(1))).toEqual([1]);
          expect(queue.availableBytes()).toBe(3);
          expect(array(queue.readAvailable(2))).toEqual([2, 3]);
          expect(queue.availableBytes()).toBe(1);
          expect(array(queue.readAvailable(1))).toEqual([4]);
          expect(queue.availableBytes()).toBe(0);
          break;
        case 148:
          queue.write(bytes(1));
          queue.close();
          expect(queue.isClosed()).toBe(false);
          expect(await queue.waitForReadableAsync()).toBe("readable");
          expect(array(queue.readAvailable(8))).toEqual([1]);
          expect(queue.isClosed()).toBe(true);
          expect(await queue.waitForReadableAsync()).toBe("closed");
          break;
        case 149: {
          const pending = queue.waitForReadableAsync();
          queue.write(bytes());
          expect(queue.availableBytes()).toBe(0);
          queue.write(bytes(1));
          expect(await pending).toBe("readable");
          expect(array(queue.readAvailable(8))).toEqual([1]);
          break;
        }
        case 150:
          queue.close();
          queue.write(bytes(1));
          expect(queue.availableBytes()).toBe(0);
          expect(await queue.waitForReadableAsync()).toBe("closed");
          break;
      }
    } finally {
      queue.close();
    }
  });
}
