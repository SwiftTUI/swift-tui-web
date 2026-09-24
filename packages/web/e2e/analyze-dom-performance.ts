import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Run with Bun and the directory containing partial-measurements.json and the
// segmented Chromium traces. Timing windows must be complete (the browser test
// rejects trace-buffer loss). Nested pipeline events count only once; work
// already included in JavaScript duration is not counted again.
interface TraceEvent {
  name: string;
  ph: string;
  pid: number;
  tid: number;
  ts: number;
  dur?: number;
}
interface Sample {
  label: string;
  js: number;
  patchAndLayout: number;
}
interface Measurement {
  width: number;
  partial: boolean;
  repeat: number;
  samples: Sample[];
}
const directory = process.argv[2];
if (!directory) throw new Error("Pass the DOM performance result directory");
const measurements: Measurement[] = JSON.parse(
  await readFile(join(directory, "partial-measurements.json"), "utf8"),
);
const groups = new Map<string, { js: number; pipeline: number }[]>();
for (const measurement of measurements) {
  const { traceEvents }: { traceEvents: TraceEvent[] } = JSON.parse(
    await readFile(
      join(
        directory,
        `browser-trace-${measurement.repeat}-${measurement.width}-${measurement.partial}.json`,
      ),
      "utf8",
    ),
  );
  const marks = new Map(
    traceEvents
      .filter((event) => event.name.startsWith("dom-"))
      .map((event) => [event.name, event]),
  );
  const names = new Set([
    "UpdateLayoutTree",
    "Layout",
    "PrePaint",
    "Paint",
    "Layerize",
  ]);
  const stages = traceEvents.filter(
    (event) => event.ph === "X" && names.has(event.name),
  );
  const key = `${measurement.width}-${measurement.partial ? "partial" : "full"}`;
  const samples = groups.get(key) ?? [];
  groups.set(key, samples);
  for (const sample of measurement.samples) {
    const start = marks.get(`${sample.label}-start`),
      end = marks.get(`${sample.label}-end`);
    if (!start || !end)
      throw new Error(`Incomplete trace window: ${sample.label}`);
    const jsEnd = start.ts + sample.js * 1000;
    const intervals = stages
      .filter((event) => event.pid === start.pid && event.tid === start.tid)
      .map(
        (event) =>
          [
            Math.max(jsEnd, event.ts),
            Math.min(end.ts, event.ts + (event.dur ?? 0)),
          ] as const,
      )
      .filter(([a, b]) => b > a)
      .sort(([a], [b]) => a - b);
    let duration = 0,
      previousEnd = 0;
    for (const [a, b] of intervals) {
      duration += Math.max(0, b - Math.max(previousEnd, a));
      previousEnd = Math.max(previousEnd, b);
    }
    samples.push({ js: sample.js, pipeline: sample.js + duration / 1000 });
  }
}
for (const [workload, samples] of groups) {
  for (const metric of ["js", "pipeline"] as const) {
    const values = samples
      .map((sample) => sample[metric])
      .sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        workload,
        metric,
        samples: values.length,
        p50: values[Math.ceil(values.length * 0.5) - 1],
        p95: values[Math.ceil(values.length * 0.95) - 1],
        max: values.at(-1),
      }),
    );
  }
}
