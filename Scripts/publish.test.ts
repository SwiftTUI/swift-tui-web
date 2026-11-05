import { describe, expect, test } from "bun:test";
import { basename } from "node:path";
import { type Candidate, type IO, publish, readHTTP, receipt } from "./publish";

const encode = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));
const api =
  "https://api.github.com/repos/SwiftTUI/swift-tui-web/releases/tags/0.21.0";
const assetUrl = (name: string) =>
  `https://github.com/SwiftTUI/swift-tui-web/releases/download/0.21.0/${name}`;
const npmUrl = (name: string) =>
  `https://registry.npmjs.org/${encodeURIComponent(name)}/0.21.0`;
function fixture() {
  const candidate: Candidate = {
    version: "0.21.0",
    commit: "a".repeat(40),
    files: [
      {
        path: "/tmp/swifttui-web-0.21.0.tgz",
        bytes: encode("web bytes"),
        package: "@swifttui/web",
      },
      {
        path: "/tmp/swifttui-build-0.21.0.tgz",
        bytes: encode("build bytes"),
        package: "@swifttui/build",
      },
    ],
  };
  const resources = new Map<string, Uint8Array>();
  const mutations: string[][] = [];
  const faults = { read: "", source: false, dependency: false, mutation: -1 };
  function asset(name: string, bytes: Uint8Array) {
    const existing = resources.get(api);
    const release = existing
      ? JSON.parse(new TextDecoder().decode(existing))
      : { assets: [] };
    release.assets.push({ name, browser_download_url: assetUrl(name) });
    resources.set(api, encode(release));
    resources.set(assetUrl(name), bytes);
  }
  function npm(index: number) {
    const file = candidate.files[index];
    const tarball = `https://registry.npmjs.org/${file.package}/-/file.tgz`;
    resources.set(
      npmUrl(file.package),
      encode({
        name: file.package,
        version: candidate.version,
        dist: { tarball },
      }),
    );
    resources.set(tarball, file.bytes);
  }
  const io: IO = {
    async read(url) {
      if (url === faults.read) throw new Error("HTTP 503");
      return resources.get(url) ?? null;
    },
    async run(command) {
      if (command[0] === "tar")
        return JSON.stringify({
          name: candidate.files.find((file) => file.path === command[2])
            ?.package,
          version: candidate.version,
          dependencies: {
            "@swifttui/web": faults.dependency ? "0.20.1" : candidate.version,
          },
        });
      if (command[0] === "git")
        return command[1] === "status"
          ? ""
          : command[1] === "rev-parse"
            ? candidate.commit
            : `${faults.source ? "b".repeat(40) : candidate.commit}\trefs/tags/0.21.0\n`;
      if (mutations.length === faults.mutation)
        throw new Error("simulated interrupted publication");
      mutations.push(command);
      if (command[0] === "npm")
        npm(candidate.files.findIndex((file) => file.path === command[2]));
      else if (command[2] === "create")
        resources.set(api, encode({ assets: [] }));
      else if (command[2] === "upload") {
        const name = basename(command[4]);
        asset(
          name,
          candidate.files.find((file) => basename(file.path) === name)?.bytes ??
            receipt(candidate),
        );
      } else throw new Error(`unexpected mutation ${command}`);
      return "";
    },
    async pause() {},
  };
  return { candidate, io, resources, mutations, asset, npm, faults };
}
describe("immutable publication recovery", () => {
  test("fresh publication then no-op retry", async () => {
    const f = fixture();
    await publish(f.candidate, f.io, "/tmp/publication.json", 1);
    expect(f.mutations).toHaveLength(6);
    expect(f.mutations.some((c) => c.includes("--clobber"))).toBe(false);
    await publish(f.candidate, f.io, "/tmp/publication.json", 1);
    expect(f.mutations).toHaveLength(6);
  });
  test("partial recovery publishes only missing matching output", async () => {
    const f = fixture();
    f.faults.mutation = 5;
    await expect(
      publish(f.candidate, f.io, "/tmp/publication.json", 1),
    ).rejects.toThrow("interrupted");
    f.faults.mutation = -1;
    await publish(f.candidate, f.io, "/tmp/publication.json", 1);
    expect(f.mutations).toHaveLength(6);
    expect(f.mutations[5].slice(0, 3)).toEqual([
      "npm",
      "publish",
      f.candidate.files[1].path,
    ]);
  });
  test("either distribution mismatch aborts before any writes", async () => {
    for (const route of ["github", "npm"]) {
      const f = fixture();
      if (route === "github")
        f.asset("swifttui-web-0.21.0.tgz", encode("wrong"));
      else {
        f.npm(1);
        f.resources.set(
          "https://registry.npmjs.org/@swifttui/build/-/file.tgz",
          encode("wrong"),
        );
      }
      await expect(
        publish(f.candidate, f.io, "/tmp/publication.json", 1),
      ).rejects.toThrow("immutable bytes differ");
      expect(f.mutations).toHaveLength(0);
    }
  });
  test("changed source receipt refuses resume with identical package bytes", async () => {
    const f = fixture();
    f.asset(
      "publication.json",
      receipt({ ...f.candidate, commit: "b".repeat(40) }),
    );
    await expect(
      publish(f.candidate, f.io, "/tmp/publication.json", 1),
    ).rejects.toThrow("immutable bytes differ");
    expect(f.mutations).toHaveLength(0);
  });
  test("wrong tag source and internal package dependency fail before writes", async () => {
    for (const fault of ["source", "dependency"] as const) {
      const f = fixture();
      f.faults[fault] = true;
      await expect(
        publish(f.candidate, f.io, "/tmp/publication.json", 1),
      ).rejects.toThrow();
      expect(f.mutations).toHaveLength(0);
    }
  });
  test("read errors and propagation do not mean missing artifacts", async () => {
    const f = fixture();
    f.faults.read = npmUrl("@swifttui/web");
    await expect(
      publish(f.candidate, f.io, "/tmp/publication.json", 1),
    ).rejects.toThrow("HTTP 503");
    expect(f.mutations).toHaveLength(0);
    f.faults.read = "";
    f.asset("swifttui-web-0.21.0.tgz", f.candidate.files[0].bytes);
    f.resources.delete(assetUrl("swifttui-web-0.21.0.tgz"));
    await expect(
      publish(f.candidate, f.io, "/tmp/publication.json", 1),
    ).rejects.toThrow("not readable");
    expect(f.mutations).toHaveLength(0);
  });
  test("only HTTP 404 means absent", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: (request) =>
        new Response("", {
          status: Number(new URL(request.url).pathname.slice(1)),
        }),
    });
    try {
      expect(await readHTTP(`http://localhost:${server.port}/404`)).toBeNull();
      for (const status of [401, 403, 429, 500, 503])
        await expect(
          readHTTP(`http://localhost:${server.port}/${status}`),
        ).rejects.toThrow(`HTTP ${status}`);
    } finally {
      server.stop(true);
    }
  });
});
