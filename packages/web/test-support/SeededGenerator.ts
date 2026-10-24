// Deterministic pseudo-random generation with shrinking, for adversarial
// property tests under `bun test`. Test-only: it lives outside `src/` so the
// browser bundle's entry graph and the WebHost bundle provenance check never
// see it, and nothing exports it from a public entrypoint. The Swift twin lives in swift-tui's SwiftTUITestSupport
// (SeededGeneration.swift); the two share the SplitMix64 stream so a seed
// reproduces the same integer sequence on both sides.

export class SeededRandomSource {
  private state: bigint;

  constructor(seed: bigint | number) {
    this.state = BigInt.asUintN(64, BigInt(seed));
  }

  /** Next 64-bit value of the SplitMix64 stream. */
  next(): bigint {
    this.state = BigInt.asUintN(64, this.state + 0x9e3779b97f4a7c15n);
    let z = this.state;
    z = BigInt.asUintN(64, (z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n);
    z = BigInt.asUintN(64, (z ^ (z >> 27n)) * 0x94d049bb133111ebn);
    return z ^ (z >> 31n);
  }

  /** Uniform integer in [low, high], inclusive. */
  int(low: number, high: number): number {
    if (high < low) throw new RangeError(`empty range ${low}...${high}`);
    const span = BigInt(high) - BigInt(low) + 1n;
    return Number(BigInt(low) + (this.next() % span));
  }

  /** Uniform double in [0, 1). */
  unit(): number {
    return Number(this.next() >> 11n) / 2 ** 53;
  }
}

export interface Shrinkable<T> {
  readonly value: T;
  /** Candidates strictly "smaller" than `value`, most aggressive first. */
  shrinks(): Shrinkable<T>[];
}

export type Gen<T> = (source: SeededRandomSource) => Shrinkable<T>;

const leaf = <T>(value: T): Shrinkable<T> => ({ value, shrinks: () => [] });

function shrinkIntegerTowards(target: number, value: number): number[] {
  if (value === target) return [];
  const out: number[] = [target];
  let delta = value - target;
  while (Math.abs(delta) > 1) {
    delta = Math.trunc(delta / 2);
    out.push(value - delta);
  }
  return [...new Set(out)].filter((candidate) => candidate !== value);
}

function integerShrinkable(
  value: number,
  low: number,
  high: number,
): Shrinkable<number> {
  const target =
    low <= 0 && high >= 0 ? 0 : Math.abs(low) < Math.abs(high) ? low : high;
  return {
    value,
    shrinks: () =>
      shrinkIntegerTowards(target, value)
        .filter((candidate) => candidate >= low && candidate <= high)
        .map((candidate) => integerShrinkable(candidate, low, high)),
  };
}

export const Gen = {
  constant<T>(value: T): Gen<T> {
    return () => leaf(value);
  },

  /** Integers in [low, high]; shrinks towards zero (or the bound nearest zero). */
  int(low: number, high: number): Gen<number> {
    return (source) => integerShrinkable(source.int(low, high), low, high);
  },

  bool(): Gen<boolean> {
    return (source) => {
      const value = source.int(0, 1) === 1;
      return { value, shrinks: () => (value ? [leaf(false)] : []) };
    };
  },

  /** Doubles in [low, high); shrinks towards zero, then towards integers. */
  double(low: number, high: number): Gen<number> {
    const shrinkable = (value: number): Shrinkable<number> => ({
      value,
      shrinks: () => {
        const out: number[] = [];
        if (value !== 0 && low <= 0 && high > 0) out.push(0);
        const truncated = Math.trunc(value);
        if (truncated !== value && truncated >= low && truncated < high)
          out.push(truncated);
        const half = value / 2;
        if (half !== value && half >= low && half < high) out.push(half);
        return out.map(shrinkable);
      },
    });
    return (source) => shrinkable(low + source.unit() * (high - low));
  },

  /**
   * Doubles that include the IEEE special values every numeric seam must
   * survive: ±0, ±Infinity, NaN, the extremes, a subnormal, and values just
   * past 2^53. One in four draws is a special value.
   */
  doubleWithSpecials(low = -1e6, high = 1e6): Gen<number> {
    const specials = [
      0,
      -0,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.NaN,
      Number.MAX_VALUE,
      -Number.MAX_VALUE,
      Number.MIN_VALUE,
      -Number.MIN_VALUE,
      Number.EPSILON,
      2 ** 53,
      2 ** 53 + 2,
      -(2 ** 53),
      1e308,
      -1e308,
      1e-308,
      Number.MAX_SAFE_INTEGER,
      Number.MIN_SAFE_INTEGER,
      0.1 + 0.2,
      1 / 3,
    ];
    const ordinary = Gen.double(low, high);
    return (source) => {
      if (source.int(0, 3) === 0) {
        const value = specials[source.int(0, specials.length - 1)] as number;
        return { value, shrinks: () => [leaf(0)] };
      }
      return ordinary(source);
    };
  },

  element<T>(values: readonly T[]): Gen<T> {
    if (values.length === 0) throw new RangeError("element(): empty list");
    return (source) => {
      const index = source.int(0, values.length - 1);
      return {
        value: values[index] as T,
        shrinks: () => (index === 0 ? [] : [leaf(values[0] as T)]),
      };
    };
  },

  /** Arrays of `minCount…maxCount` elements; shrinks by dropping halves, then single elements, then elements in place. */
  array<T>(element: Gen<T>, minCount: number, maxCount: number): Gen<T[]> {
    const shrinkable = (items: Shrinkable<T>[]): Shrinkable<T[]> => ({
      value: items.map((item) => item.value),
      shrinks: () => {
        const out: Shrinkable<T>[][] = [];
        for (
          let chunk = Math.floor(items.length / 2);
          chunk >= 1;
          chunk = Math.floor(chunk / 2)
        ) {
          for (let start = 0; start + chunk <= items.length; start += chunk) {
            const candidate = [
              ...items.slice(0, start),
              ...items.slice(start + chunk),
            ];
            if (candidate.length >= minCount) out.push(candidate);
          }
        }
        items.forEach((item, index) => {
          for (const smaller of item.shrinks()) {
            out.push([
              ...items.slice(0, index),
              smaller,
              ...items.slice(index + 1),
            ]);
          }
        });
        return out.map(shrinkable);
      },
    });
    return (source) => {
      const count = source.int(minCount, maxCount);
      const items: Shrinkable<T>[] = [];
      for (let i = 0; i < count; i += 1) items.push(element(source));
      return shrinkable(items);
    };
  },

  /** Strings assembled from an alphabet of grapheme clusters (see `graphemeAlphabet`). */
  string(
    alphabet: readonly string[],
    minCount: number,
    maxCount: number,
  ): Gen<string> {
    const pieces = Gen.array(Gen.element(alphabet), minCount, maxCount);
    return Gen.map(pieces, (items) => items.join(""));
  },

  map<T, U>(gen: Gen<T>, transform: (value: T) => U): Gen<U> {
    const lift = (inner: Shrinkable<T>): Shrinkable<U> => ({
      value: transform(inner.value),
      shrinks: () => inner.shrinks().map(lift),
    });
    return (source) => lift(gen(source));
  },

  zip<A, B>(a: Gen<A>, b: Gen<B>): Gen<[A, B]> {
    const pair = (x: Shrinkable<A>, y: Shrinkable<B>): Shrinkable<[A, B]> => ({
      value: [x.value, y.value],
      shrinks: () => [
        ...x.shrinks().map((xs) => pair(xs, y)),
        ...y.shrinks().map((ys) => pair(x, ys)),
      ],
    });
    return (source) => pair(a(source), b(source));
  },

  /** Dependent generation; shrinks the outer value first, then the inner. */
  flatMap<T, U>(gen: Gen<T>, next: (value: T) => Gen<U>): Gen<U> {
    return (source) => {
      const outer = gen(source);
      const seed = source.next();
      const build = (o: Shrinkable<T>): Shrinkable<U> => {
        const inner = next(o.value)(new SeededRandomSource(seed));
        return {
          value: inner.value,
          shrinks: () => [...o.shrinks().map(build), ...inner.shrinks()],
        };
      };
      return build(outer);
    };
  },
};

/**
 * Grapheme clusters that have broken SwiftTUI seams before: combining marks,
 * ZWJ sequences, regional indicators, skin tones, Hangul jamo, wide CJK,
 * every newline convention, zero-width and bidi controls, soft hyphen, and a
 * replacement character. Pair with `Gen.string`.
 */
export const graphemeAlphabet: readonly string[] = [
  "a",
  "Z",
  "0",
  " ",
  "-",
  ".",
  "'",
  "é",
  "́",
  "a⃝",
  "é",
  "\u{1F469}\u{1F3FD}‍\u{1F4BB}",
  "\u{1F1FA}\u{1F1F8}",
  "\u{1F600}",
  "\u{1F44D}\u{1F3FF}",
  "각",
  "가",
  "界",
  "宽",
  "ｗ",
  "\r",
  "\n",
  "\r\n",
  "\t",
  " ",
  " ",
  "\u0085",
  "​",
  "‍",
  "­",
  "‎",
  "‏",
  "⁦",
  "⁩",
  "�",
  "\u0000",
  "\u001b",
  "\u007f",
];

export interface PropertyFailure<T> {
  readonly seed: bigint;
  readonly iteration: number;
  readonly original: T;
  readonly minimal: T;
  readonly shrinkSteps: number;
  readonly error: unknown;
}

export interface PropertyResult<T> {
  readonly passed: number;
  readonly failure: PropertyFailure<T> | null;
}

export interface PropertyOptions {
  seed?: bigint | number;
  iterations?: number;
  maxShrinkSteps?: number;
}

function envNumber(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Default seed and iteration count; `SWIFTTUI_PROPERTY_SEED`, `SWIFTTUI_PROPERTY_ITERATIONS` and `SWIFTTUI_STRESS_FULL=1` override them. */
export function propertyDefaults(): { seed: bigint; iterations: number } {
  const seed = BigInt(envNumber("SWIFTTUI_PROPERTY_SEED") ?? 0x5a177a11);
  const explicit = envNumber("SWIFTTUI_PROPERTY_ITERATIONS");
  const full = process.env.SWIFTTUI_STRESS_FULL === "1";
  return { seed, iterations: explicit ?? (full ? 1000 : 100) };
}

/**
 * Runs `body` over `iterations` generated values. A thrown error (including a
 * failed `expect`) is a counterexample; it is shrunk greedily and reported
 * with the seed that reproduces it. Returns rather than throws so the test
 * can assert on the result with its own message.
 */
export function checkProperty<T>(
  gen: Gen<T>,
  body: (value: T) => void,
  options: PropertyOptions = {},
): PropertyResult<T> {
  const defaults = propertyDefaults();
  const seed = BigInt.asUintN(64, BigInt(options.seed ?? defaults.seed));
  const iterations = options.iterations ?? defaults.iterations;
  const maxShrinkSteps = options.maxShrinkSteps ?? 500;
  const source = new SeededRandomSource(seed);
  const fails = (value: T): unknown => {
    try {
      body(value);
      return null;
    } catch (error) {
      return error ?? new Error("property body threw undefined");
    }
  };
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const candidate = gen(source);
    const error = fails(candidate.value);
    if (error === null) continue;
    let current = candidate;
    let currentError = error;
    let steps = 0;
    let progressed = true;
    while (progressed && steps < maxShrinkSteps) {
      progressed = false;
      for (const smaller of current.shrinks()) {
        steps += 1;
        const smallerError = fails(smaller.value);
        if (smallerError !== null) {
          current = smaller;
          currentError = smallerError;
          progressed = true;
          break;
        }
        if (steps >= maxShrinkSteps) break;
      }
    }
    return {
      passed: iteration,
      failure: {
        seed,
        iteration,
        original: candidate.value,
        minimal: current.value,
        shrinkSteps: steps,
        error: currentError,
      },
    };
  }
  return { passed: iterations, failure: null };
}

/** Formats a failure for an `expect` message: seed, iteration, minimal counterexample and the error. */
export function describeFailure<T>(result: PropertyResult<T>): string {
  if (!result.failure) return `passed ${result.passed} iterations`;
  const f = result.failure;
  const message = f.error instanceof Error ? f.error.message : String(f.error);
  return `seed=0x${f.seed.toString(16)} iteration=${f.iteration} shrinkSteps=${f.shrinkSteps}\nminimal=${JSON.stringify(f.minimal)}\noriginal=${JSON.stringify(f.original)}\n${message}`;
}
