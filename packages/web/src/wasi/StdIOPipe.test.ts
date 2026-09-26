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
