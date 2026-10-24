import { expect, test } from "bun:test";

import {
  checkProperty,
  describeFailure,
  Gen,
  graphemeAlphabet,
  SeededRandomSource,
} from "./SeededGenerator.ts";

test("SplitMix64 reproduces the reference stream for seed 0", () => {
  // Reference values from the SplitMix64 paper's test vector (seed 0).
  const source = new SeededRandomSource(0);
  expect(source.next()).toBe(0xe220a8397b1dcdafn);
  expect(source.next()).toBe(0x6e789e6aa1b965f4n);
  expect(source.next()).toBe(0x06c45d188009454fn);
});

test("the same seed yields the same values and a different seed does not", () => {
  const a = Gen.array(Gen.int(-50, 50), 0, 8);
  const draw = (seed: number) => a(new SeededRandomSource(seed)).value;
  expect(draw(7)).toEqual(draw(7));
  expect(draw(7)).not.toEqual(draw(8));
});

test("integer shrinking reaches the smallest failing value", () => {
  const result = checkProperty(
    Gen.int(0, 10_000),
    (n) => {
      if (n >= 37) throw new Error(`too big: ${n}`);
    },
    { seed: 1, iterations: 200 },
  );
  expect(result.failure?.minimal).toBe(37);
});

test("array shrinking removes unrelated elements and shrinks the culprit", () => {
  const result = checkProperty(
    Gen.array(Gen.int(0, 100), 0, 20),
    (items) => {
      if (items.some((n) => n > 60)) throw new Error("has a large element");
    },
    { seed: 3, iterations: 200 },
  );
  expect(result.failure?.minimal).toEqual([61]);
});

test("string generation covers the hostile grapheme alphabet and shrinks to one piece", () => {
  const result = checkProperty(
    Gen.string(graphemeAlphabet, 1, 12),
    (s) => {
      if (s.includes("‍")) throw new Error("contains ZWJ");
    },
    { seed: 11, iterations: 500 },
  );
  const minimal = result.failure?.minimal ?? "";
  expect(result.failure).not.toBeNull();
  expect([...minimal].length).toBeLessThanOrEqual(5);
  expect(minimal).toContain("‍");
});

test("special doubles are drawn and a passing property reports its iteration count", () => {
  const seen = new Set<string>();
  const result = checkProperty(
    Gen.doubleWithSpecials(),
    (x) => {
      seen.add(Number.isNaN(x) ? "nan" : Object.is(x, -0) ? "-0" : String(x));
    },
    { seed: 5, iterations: 400 },
  );
  expect(result.failure).toBeNull();
  expect(result.passed).toBe(400);
  expect(seen.has("nan")).toBe(true);
  expect(seen.has("Infinity")).toBe(true);
  expect(seen.has("-0")).toBe(true);
});

test("describeFailure names the seed and the minimal counterexample", () => {
  const result = checkProperty(
    Gen.zip(Gen.int(0, 9), Gen.bool()),
    ([n, flag]) => {
      if (flag && n > 2) throw new Error("pair failed");
    },
    { seed: 9, iterations: 100 },
  );
  const text = describeFailure(result);
  expect(text).toContain("seed=0x9");
  expect(text).toContain("minimal=[3,true]");
});
