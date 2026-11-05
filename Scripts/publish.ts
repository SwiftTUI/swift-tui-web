/** Immutable release publication. Existing bytes are checked before any writes. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const repository = "SwiftTUI/swift-tui-web";
const api = `https://api.github.com/repos/${repository}`;
const registry = "https://registry.npmjs.org";

type Asset = { name: string; browser_download_url: string };
type Release = { assets: Asset[] };
export type IO = {
  read(url: string): Promise<Uint8Array | null>;
  run(command: string[]): Promise<string>;
  pause(): Promise<void>;
};
export type Candidate = {
  version: string;
  commit: string;
  files: { path: string; bytes: Uint8Array; package: string }[];
};

function requireCondition(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function hash(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}
function json(bytes: Uint8Array) {
  return JSON.parse(new TextDecoder().decode(bytes));
}
export function receipt(candidate: Candidate) {
  return new TextEncoder().encode(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        version: candidate.version,
        commit: candidate.commit,
        artifacts: Object.fromEntries(
          candidate.files.map((file) => [
            basename(file.path),
            hash(file.bytes),
          ]),
        ),
      },
      null,
      2,
    )}\n`,
  );
}
class PropagationPending extends Error {}
function same(actual: Uint8Array, expected: Uint8Array, label: string) {
  requireCondition(
    hash(actual) === hash(expected),
    `${label}: immutable bytes differ; publish a new version`,
  );
}

/** Only a confirmed HTTP 404 is absence. Authentication/server failures abort. */
export async function readHTTP(url: string): Promise<Uint8Array | null> {
  const headers: Record<string, string> = { "User-Agent": "swifttui-release" };
  if (url.startsWith("https://api.github.com/")) {
    headers.Accept = "application/vnd.github+json";
    if (process.env.GH_TOKEN)
      headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  }
  const response = await fetch(url, { headers });
  if (response.status === 404) return null;
  requireCondition(
    response.ok,
    `${url}: HTTP ${response.status}; refusing to treat a read failure as absence`,
  );
  return new Uint8Array(await response.arrayBuffer());
}

async function inspect(candidate: Candidate, io: IO) {
  const releaseBytes = await io.read(
    `${api}/releases/tags/${candidate.version}`,
  );
  const release: Release | null = releaseBytes ? json(releaseBytes) : null;
  const wanted = [
    ...candidate.files.map((file) => ({
      name: basename(file.path),
      bytes: file.bytes,
    })),
    { name: "publication.json", bytes: receipt(candidate) },
  ];
  const missingAssets: string[] = [];
  for (const file of wanted) {
    const matches =
      release?.assets.filter((asset) => asset.name === file.name) ?? [];
    requireCondition(
      matches.length <= 1,
      `duplicate release asset ${file.name}`,
    );
    if (!matches.length) {
      missingAssets.push(file.name);
      continue;
    }
    const url = matches[0].browser_download_url;
    requireCondition(
      url ===
        `https://github.com/${repository}/releases/download/${candidate.version}/${file.name}`,
      "unexpected GitHub asset coordinates",
    );
    const bytes = await io.read(url);
    // An asset listed but unreadable is propagation/failure, never absence.
    if (bytes === null)
      throw new PropagationPending(
        `${file.name}: listed asset is not readable; retry after propagation`,
      );
    same(bytes, file.bytes, file.name);
  }
  const missingNpm: string[] = [];
  for (const file of candidate.files) {
    const metadata = await io.read(
      `${registry}/${encodeURIComponent(file.package)}/${candidate.version}`,
    );
    if (!metadata) {
      missingNpm.push(file.package);
      continue;
    }
    const published = json(metadata);
    requireCondition(
      published.name === file.package &&
        published.version === candidate.version,
      "wrong npm publication identity",
    );
    const url = new URL(published.dist.tarball);
    requireCondition(
      url.origin === registry && !url.username && !url.password,
      "unexpected npm tarball host",
    );
    const bytes = await io.read(url.href);
    if (bytes === null)
      throw new PropagationPending(
        `${file.package}: registry lists an unreadable tarball; retry after propagation`,
      );
    same(bytes, file.bytes, file.package);
  }
  return { release, missingAssets, missingNpm };
}

export async function publish(
  candidate: Candidate,
  io: IO,
  receiptPath: string,
  attempts = 21,
) {
  requireCondition(
    /^0\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(candidate.version),
    "expected a stable pre-1.0 release tag",
  );
  requireCondition(
    /^[0-9a-f]{40}$/.test(candidate.commit),
    "expected a full release commit",
  );
  requireCondition(
    candidate.files.length === 2 &&
      candidate.files.every(
        (file, index) =>
          file.package === ["@swifttui/web", "@swifttui/build"][index] &&
          basename(file.path) ===
            `swifttui-${index === 0 ? "web" : "build"}-${candidate.version}.tgz`,
      ),
    "expected the web/build release pair",
  );
  for (const file of candidate.files) {
    const metadata = JSON.parse(
      await io.run(["tar", "-xOzf", file.path, "package/package.json"]),
    );
    requireCondition(
      metadata.name === file.package && metadata.version === candidate.version,
      "local tarball identity differs",
    );
    if (file.package === "@swifttui/build") {
      requireCondition(
        metadata.dependencies?.["@swifttui/web"] === candidate.version,
        "local build tarball must depend on the exact paired web version",
      );
    }
  }
  const head = (await io.run(["git", "rev-parse", "HEAD"])).trim();
  requireCondition(
    head === candidate.commit,
    "checkout does not match the selected release commit",
  );
  requireCondition(
    !(
      await io.run(["git", "status", "--porcelain", "--untracked-files=normal"])
    ).trim(),
    "release checkout is dirty; artifacts must come from the selected commit",
  );
  const tag = `refs/tags/${candidate.version}`;
  const refs = (
    await io.run([
      "git",
      "ls-remote",
      `https://github.com/${repository}.git`,
      tag,
      `${tag}^{}`,
    ])
  )
    .trim()
    .split("\n")
    .map((line) => line.split(/\s+/));
  const selected =
    refs.find((ref) => ref[1] === `${tag}^{}`) ??
    refs.find((ref) => ref[1] === tag);
  requireCondition(
    selected?.[0] === candidate.commit,
    "published tag does not match the selected release commit",
  );
  // Inspect BOTH distribution routes before creating or uploading anything.
  const state = await inspect(candidate, io);
  if (!state.release) {
    await io.run([
      "gh",
      "release",
      "create",
      candidate.version,
      "--repo",
      repository,
      "--verify-tag",
      "--title",
      candidate.version,
      "--notes",
      "",
    ]);
  }
  // Bind the source before publishing artifacts so a partial retry has an identity.
  for (const name of [
    "publication.json",
    ...candidate.files.map((file) => basename(file.path)),
  ]) {
    if (!state.missingAssets.includes(name)) continue;
    const path =
      name === "publication.json"
        ? receiptPath
        : candidate.files.find((file) => basename(file.path) === name)?.path;
    requireCondition(path, `missing local asset ${name}`);
    await io.run([
      "gh",
      "release",
      "upload",
      candidate.version,
      path,
      "--repo",
      repository,
    ]);
  }
  for (const file of candidate.files) {
    if (state.missingNpm.includes(file.package)) {
      await io.run([
        "npm",
        "publish",
        file.path,
        "--access",
        "public",
        "--provenance",
      ]);
    }
  }
  // Poll missing listings only. Mismatching bytes are an immediate hard failure.
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const result = await inspect(candidate, io);
      if (!result.missingAssets.length && !result.missingNpm.length) return;
    } catch (error) {
      if (!(error instanceof PropagationPending)) throw error;
    }
    if (attempt + 1 < attempts) await io.pause();
  }
  throw new Error(
    "publication remains incomplete after propagation deadline; retry the same candidate",
  );
}

if (import.meta.main) {
  const [version, commit, web, build] = process.argv.slice(2);
  requireCondition(
    version && commit && web && build,
    "Usage: bun Scripts/publish.ts VERSION FULL_SHA WEB_TGZ BUILD_TGZ",
  );
  const candidate: Candidate = {
    version,
    commit,
    files: [
      { path: web, bytes: await readFile(web), package: "@swifttui/web" },
      { path: build, bytes: await readFile(build), package: "@swifttui/build" },
    ],
  };
  const receiptPath = `${web.slice(0, -basename(web).length)}publication.json`;
  await Bun.write(receiptPath, receipt(candidate));
  await publish(
    candidate,
    {
      read: readHTTP,
      async run(command) {
        const result = Bun.spawnSync(command, {
          stdout: "pipe",
          stderr: "pipe",
        });
        requireCondition(
          result.exitCode === 0,
          `${command[0]} ${command[1]} failed: ${result.stderr.toString()}`,
        );
        return result.stdout.toString();
      },
      pause: () => Bun.sleep(15_000),
    },
    receiptPath,
  );
  console.log(
    "Published web/build: both routes match the selected source and artifact bytes.",
  );
}
