import { expect, test } from "bun:test";
import { StdIOPipe } from "./StdIOPipe.ts";

test("an exclusive byte consumer drains startup data and does not retain delivered history", () => {
  const pipe = new StdIOPipe();
  pipe.write("queued");
  let consumed = 0;
  const detach = pipe.consume((bytes) => {
    consumed += bytes.length;
  });
  expect(consumed).toBe(6);
  const chunk = new Uint8Array(8192);
  for (let i = 0; i < 10000; i++) pipe.write(chunk);
  expect(consumed).toBe(6 + 8192 * 10000);
  expect(pipe.bufferedBytes).toBe(0);
  detach();
  pipe.write("next");
  expect(pipe.bufferedBytes).toBe(4);
});

test("observers preserve readable bytes and consumer backpressure is returned", async () => {
  const pipe = new StdIOPipe();
  let observed = 0;
  pipe.subscribe((bytes) => {
    observed += bytes.length;
  });
  pipe.write("read");
  expect(new TextDecoder().decode(await pipe.read())).toBe("read");
  pipe.consume(() => false);
  expect(pipe.write("consumed")).toBe(false);
  expect(observed).toBe(12);
  expect(pipe.bufferedBytes).toBe(0);
  await expect(pipe.read()).rejects.toThrow("exclusive consumer");
  expect(() => pipe.consume(() => {})).toThrow("exclusive consumer");
  pipe.close();
  expect(pipe.write("late")).toBe(false);
});

test("pending reads stay exclusive and close settles them", async () => {
  const pipe = new StdIOPipe();
  const read = pipe.read();
  expect(() => pipe.consume(() => {})).toThrow("pending read");
  pipe.close();
  expect(await read).toBeUndefined();
});

// Wave 2 repair scenarios for STUI-1181: a write that satisfies an already
// pending read is still a future write for every observer.
const chunkArray = (chunk: Uint8Array | undefined) =>
  chunk === undefined ? undefined : [...chunk];

test("observers see writes that satisfy pending reads, in FIFO order (wave2web-r02)", async () => {
  const pipe = new StdIOPipe();
  const observed: number[][] = [];
  pipe.subscribe((chunk) => {
    observed.push([...chunk]);
  });
  const first = pipe.read();
  const second = pipe.read();
  pipe.write(new Uint8Array([1]));
  pipe.write(new Uint8Array([2]));
  expect((await Promise.all([first, second])).map(chunkArray)).toEqual([
    [1],
    [2],
  ]);
  expect(observed).toEqual([[1], [2]]);
  expect(pipe.bufferedBytes).toBe(0);
  pipe.close();
});

test("an observer declining a write to a pending read is reported (wave2web-r03)", async () => {
  const pipe = new StdIOPipe();
  let calls = 0;
  pipe.subscribe(() => {
    calls += 1;
    return false;
  });
  const pending = pipe.read();
  expect(pipe.write(new Uint8Array([7]))).toBe(false);
  expect(chunkArray(await pending)).toEqual([7]);
  expect(calls).toBe(1);
  expect(pipe.bufferedBytes).toBe(0);
  pipe.close();
});

test("a pending read takes its chunk without retaining a copy (wave2web-r04)", async () => {
  const pipe = new StdIOPipe();
  const pending = pipe.read();
  expect(pipe.write(new Uint8Array([3]))).toBe(true);
  expect(chunkArray(await pending)).toEqual([3]);
  expect(pipe.bufferedBytes).toBe(0);
  pipe.close();
});

test("a detached observer misses writes to pending reads (wave2web-r05)", async () => {
  const pipe = new StdIOPipe();
  const observed: number[][] = [];
  const detach = pipe.subscribe((chunk) => {
    observed.push([...chunk]);
  });
  detach();
  const pending = pipe.read();
  pipe.write(new Uint8Array([4]));
  expect(chunkArray(await pending)).toEqual([4]);
  expect(observed).toEqual([]);
  pipe.close();
});

test("close settles a pending read without notifying observers (wave2web-r07)", async () => {
  const pipe = new StdIOPipe();
  const observed: number[][] = [];
  pipe.subscribe((chunk) => {
    observed.push([...chunk]);
  });
  const pending = pipe.read();
  pipe.close();
  expect(await pending).toBeUndefined();
  expect(pipe.write(new Uint8Array([5]))).toBe(false);
  expect(observed).toEqual([]);
});
