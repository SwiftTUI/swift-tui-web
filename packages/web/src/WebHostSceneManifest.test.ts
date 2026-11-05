import { expect, test } from "bun:test";

import {
  normalizeWebHostSceneManifest,
  webTUISceneManifestToJSON,
} from "./WebHostSceneManifest.ts";

test("scene manifests preserve declaration order and default scene", () => {
  const manifest = normalizeWebHostSceneManifest([
    { id: "dashboard", title: "Dashboard", isDefault: true },
    { id: "controls", title: "Controls", isDefault: false },
  ]);

  expect(manifest.defaultSceneId).toBe("dashboard");
  expect(manifest.scenes.map((scene) => scene.id)).toEqual([
    "dashboard",
    "controls",
  ]);
  expect(webTUISceneManifestToJSON(manifest)).toBe(
    JSON.stringify({
      defaultSceneId: "dashboard",
      scenes: [
        { id: "dashboard", title: "Dashboard", isDefault: true },
        { id: "controls", title: "Controls", isDefault: false },
      ],
    }),
  );
});

test("scene manifests infer a default scene when one is not marked", () => {
  const manifest = normalizeWebHostSceneManifest([
    { id: "primary", title: "Primary", isDefault: false },
    { id: "secondary", title: "Secondary", isDefault: false },
  ]);

  expect(manifest.defaultSceneId).toBe("primary");
  expect(manifest.scenes[0]?.isDefault).toBe(true);
});

test("explicit defaults win over legacy flags for both key spellings", () => {
  for (const key of ["defaultSceneId", "defaultSceneID"]) {
    const manifest = normalizeWebHostSceneManifest({
      [key]: "second",
      scenes: [
        { id: "first", isDefault: true },
        { id: "second", title: null },
      ],
    });
    expect(manifest.defaultSceneId).toBe("second");
    expect(manifest.scenes.map((scene) => scene.isDefault)).toEqual([
      false,
      true,
    ]);
    expect(
      normalizeWebHostSceneManifest(
        JSON.parse(webTUISceneManifestToJSON(manifest)),
      ),
    ).toEqual(manifest);
  }
});

test("ambiguous catalogs fail with an actionable error", () => {
  const scenes = [{ id: "a" }, { id: "b" }];
  for (const source of [
    { scenes, defaultSceneId: "a", defaultSceneID: "b" },
    { scenes, defaultSceneId: "missing" },
    { scenes, defaultSceneId: 1 },
    [{ id: "a" }, { id: "a" }],
    [
      { id: "a", isDefault: true },
      { id: "b", isDefault: true },
    ],
    [{ id: "a", isDefault: "false" }],
    [{ id: "a", isDefault: null }],
    [{ id: 42 }],
    [],
  ])
    expect(() => normalizeWebHostSceneManifest(source)).toThrow();
});

test("serialization derives every legacy flag from the selected default", () => {
  const bytes = webTUISceneManifestToJSON({
    defaultSceneId: "b",
    scenes: [
      { id: "a", isDefault: true },
      { id: "b", isDefault: false },
    ],
  });
  // The released reader chooses the first true flag; it ignores the explicit key.
  expect(
    JSON.parse(bytes).scenes.find(
      (scene: { isDefault: boolean }) => scene.isDefault,
    ).id,
  ).toBe("b");
});
