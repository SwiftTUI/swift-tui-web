import { expect, test } from "bun:test";
import { StdIOPipe } from "./StdIOPipe.ts";
import { deliverToStdIOPipe } from "./StdIOPipeDelivery.ts";

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

// Wave-2 regression hunt, part CB (STUI-1165): neighbours of the STUI-1181
// repair. The coordination root's wave-2 hunt evidence owns the case
// descriptions (w2cb001–w2cb003).

test("w2cb001 an async-iterator reader and an observer see every write once in order", async () => {
  const pipe = new StdIOPipe();
  const observed: number[][] = [];
  pipe.subscribe((chunk) => {
    observed.push([...chunk]);
  });
  const iterator = pipe[Symbol.asyncIterator]();
  const received: (number[] | undefined)[] = [];
  const first = iterator.next();
  pipe.write(new Uint8Array([1]));
  const waiterTookFirst = pipe.bufferedBytes === 0;
  received.push(chunkArray((await first).value));
  // The iterator is not parked: these writes take the queued path.
  pipe.write(new Uint8Array([2]));
  pipe.write(new Uint8Array([3]));
  const queuedWhileBusy = pipe.bufferedBytes;
  received.push(chunkArray((await iterator.next()).value));
  received.push(chunkArray((await iterator.next()).value));
  const fourth = iterator.next();
  pipe.write(new Uint8Array([4]));
  const waiterTookFourth = pipe.bufferedBytes === 0;
  received.push(chunkArray((await fourth).value));
  pipe.close();
  const end = await iterator.next();
  expect({ waiterTookFirst, queuedWhileBusy, waiterTookFourth }).toEqual({
    waiterTookFirst: true,
    queuedWhileBusy: 2,
    waiterTookFourth: true,
  });
  expect(received).toEqual([[1], [2], [3], [4]]);
  expect(observed).toEqual([[1], [2], [3], [4]]);
  expect(end.done).toBe(true);
  expect(pipe.bufferedBytes).toBe(0);
});

test("w2cb002 a throwing observer does not take a waiter-path chunk from its reader", async () => {
  const pipe = new StdIOPipe();
  const seen: number[][] = [];
  const detachThrowing = pipe.subscribe(() => {
    throw new Error("observer failed");
  });
  pipe.subscribe((chunk) => {
    seen.push([...chunk]);
  });
  const first = pipe.read();
  try {
    pipe.write(new Uint8Array([1]));
  } catch {
    // Whether a throwing observer's error reaches the writer is not under test.
  }
  expect(chunkArray(await first)).toEqual([1]);
  expect(pipe.bufferedBytes).toBe(0);
  detachThrowing();
  const second = pipe.read();
  expect(pipe.write(new Uint8Array([2]))).toBe(true);
  expect(chunkArray(await second)).toEqual([2]);
  expect(pipe.bufferedBytes).toBe(0);
  expect(seen.at(-1)).toEqual([2]);
  pipe.close();
});

test("w2cb003 waiter-path delivery is isolated from later writer-buffer mutation", async () => {
  const pipe = new StdIOPipe();
  let observedChunk: Uint8Array | undefined;
  pipe.subscribe((chunk) => {
    observedChunk = chunk;
  });
  const pending = pipe.read();
  const source = new Uint8Array([5, 6]);
  pipe.write(source);
  source.fill(9);
  const delivered = await pending;
  expect(chunkArray(delivered)).toEqual([5, 6]);
  expect(chunkArray(observedChunk)).toEqual([5, 6]);
  pipe.close();
});

// Wave 3 repair scenario for STUI-1252 (w3cb-w03): delivery is reported apart
// from observation. A declining observer still makes write() return false
// (STUI-1181), but the chunk it declined was delivered.
test("a delivered chunk stays delivered when an observer declines it (w3cb-w03)", async () => {
  const declined: number[][] = [];
  const decliningPipe = () => {
    const pipe = new StdIOPipe();
    pipe.subscribe((chunk) => {
      declined.push([...chunk]);
      return false;
    });
    return pipe;
  };

  const waiterPipe = decliningPipe();
  const pending = waiterPipe.read();
  const waiterDelivered = deliverToStdIOPipe(waiterPipe, new Uint8Array([1]));
  const waiterChunk = chunkArray(await pending);
  const waiterWrite = waiterPipe.read();
  const waiterWriteResult = waiterPipe.write(new Uint8Array([2]));
  await waiterWrite;

  const queuePipe = decliningPipe();
  const queueDelivered = deliverToStdIOPipe(queuePipe, new Uint8Array([3]));
  const queuedBytes = queuePipe.bufferedBytes;
  const queueWriteResult = queuePipe.write(new Uint8Array([4]));
  const queued = [
    chunkArray(await queuePipe.read()),
    chunkArray(await queuePipe.read()),
  ];

  const refusingPipe = new StdIOPipe();
  let refusals = 0;
  refusingPipe.consume(() => {
    refusals += 1;
    return false;
  });
  const refusedDelivered = deliverToStdIOPipe(
    refusingPipe,
    new Uint8Array([5]),
  );

  const closedPipe = decliningPipe();
  closedPipe.close();
  const closedDelivered = deliverToStdIOPipe(closedPipe, new Uint8Array([6]));

  expect({
    waiterDelivered,
    waiterChunk,
    waiterWriteResult,
    queueDelivered,
    queuedBytes,
    queueWriteResult,
    queued,
    refusedDelivered,
    refusals,
    closedDelivered,
    declined,
  }).toEqual({
    waiterDelivered: true,
    waiterChunk: [1],
    waiterWriteResult: false,
    queueDelivered: true,
    queuedBytes: 1,
    queueWriteResult: false,
    queued: [[3], [4]],
    refusedDelivered: false,
    refusals: 1,
    closedDelivered: false,
    declined: [[1], [2], [3], [4]],
  });
  expect(queuePipe.bufferedBytes).toBe(0);
});

// Wave 4 repair scenarios for STUI-1294 (w4web-p01 to p04). A chunk written
// before a consumer attached was reported delivered, so the pipe keeps it
// queued when the consumer refuses it at attachment, and later writes cannot
// overtake it.
test("a consumer that refuses a queued chunk at attachment leaves it queued, in order (w4web-p01 to p03)", () => {
  const pipe = new StdIOPipe();
  const observed: number[][] = [];
  pipe.subscribe((chunk) => {
    observed.push([...chunk]);
  });
  pipe.write(new Uint8Array([1]));
  pipe.write(new Uint8Array([2, 2]));
  pipe.write(new Uint8Array([3, 3, 3]));
  const offered: number[][] = [];
  let accepting = (chunk: Uint8Array) => chunk[0] !== 2;
  pipe.consume((chunk) => {
    offered.push([...chunk]);
    return accepting(chunk);
  });
  const afterAttach = { offered: [...offered], buffered: pipe.bufferedBytes };

  offered.length = 0;
  const refusedWrite = pipe.write(new Uint8Array([4]));
  const whileRefusing = { offered: [...offered], buffered: pipe.bufferedBytes };

  offered.length = 0;
  accepting = () => true;
  const acceptedWrite = pipe.write(new Uint8Array([5]));

  expect({
    afterAttach,
    refusedWrite,
    whileRefusing,
    acceptedWrite,
    offered,
    buffered: pipe.bufferedBytes,
    observed,
  }).toEqual({
    afterAttach: { offered: [[1], [2, 2]], buffered: 5 },
    refusedWrite: false,
    whileRefusing: { offered: [[2, 2]], buffered: 5 },
    acceptedWrite: true,
    offered: [[2, 2], [3, 3, 3], [5]],
    buffered: 0,
    observed: [[1], [2, 2], [3, 3, 3], [4], [5]],
  });
});

test("a refused queued chunk is readable after the consumer detaches (w4web-p04)", async () => {
  const pipe = new StdIOPipe();
  pipe.write(new Uint8Array([1]));
  pipe.write(new Uint8Array([2]));
  const detach = pipe.consume(() => false);
  detach();
  // Checked before reading, so a lost chunk fails here instead of parking.
  expect(pipe.bufferedBytes).toBe(2);
  expect([
    chunkArray(await pipe.read()),
    chunkArray(await pipe.read()),
  ]).toEqual([[1], [2]]);
  expect(pipe.bufferedBytes).toBe(0);
});
