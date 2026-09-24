import manifest from "../fonts/manifest.json";
import { qualifyFont } from "./font-qualification.ts";

const result = await qualifyFont(manifest.faces);
const errors: string[] = [];
for (const size of [12, 14, 16, 20, 24, 32]) {
  const rows = result.measurements.filter((row) => row.size === size);
  if (
    Math.max(...rows.map((r) => r.advance)) -
      Math.min(...rows.map((r) => r.advance)) >
    0.02
  )
    errors.push(`Face advances differ at ${size}`);
  if (
    Math.max(...rows.map((r) => r.baseline)) -
      Math.min(...rows.map((r) => r.baseline)) >
    0.5
  )
    errors.push(`Baselines differ at ${size}`);
  for (const row of rows)
    for (const sample of row.samples)
      if (Math.abs(sample.width - row.advance) > 0.05)
        errors.push(`Sample ${sample.text} differs at ${size}`);
}
const report = { ...result, errors, manifest };
const heading = document.createElement("h1");
heading.textContent = errors.length
  ? `FAIL: ${errors.join(", ")}`
  : "PASS: four font faces, six sizes, equal advances and baselines";
document.body.prepend(heading);
const details = document.createElement("pre");
details.textContent = JSON.stringify(report, null, 2);
document.body.append(details);
// An optional local evidence collector. Qualification also works without it.
if (new URL(location.href).searchParams.has("collect"))
  await fetch("/font-result", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(report),
  });
