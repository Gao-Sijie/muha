import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { MUHA_DELIVERY_PACKAGES } from "../../scripts/delivery-manifest.mjs";
import { validatePublicationManifest } from "../../scripts/publication-candidate.mjs";

const root = resolve(import.meta.dirname, "../..");
const revision = "a".repeat(40), version = "0.1.13";
const candidate = () => ({
  delivery: "public-npm-candidate", candidate: true, version,
  source: { revision, dirty: false, tree: "b".repeat(40), lockfileSha256: "c".repeat(64) },
  packages: MUHA_DELIVERY_PACKAGES.map(item => ({
    name: item.packageName, version, filename: `${item.artifactStem}-${version}.tgz`,
    dependencies: item.role === "adapter" ? { "@muha-sdk/core": version } : {},
    sha256: "d".repeat(64), integrity: "sha512-ZA==",
    resources: ["package.json", "LICENSE", "README.md", ...item.requiredFiles].map(path => ({ path })),
    files: ["package.json", "LICENSE", "README.md", "dist/index.d.ts", ...item.requiredFiles].map(path => ({ path })),
  })),
});

test("publication rejects diagnostics, changed sources, mixed versions and missing runtime resources", () => {
  validatePublicationManifest(candidate(), { revision, version });
  const mutations = [
    release => { release.delivery = "diagnostic-npm-tarballs"; },
    release => { release.candidate = false; },
    release => { release.source.dirty = true; },
    release => { release.source.revision = "e".repeat(40); },
    release => { release.packages.pop(); },
    release => { release.packages[1].version = "0.1.12"; },
    release => { release.packages[1].dependencies["@muha-sdk/core"] = "^0.1.13"; },
    release => { release.packages[0].name = "muha-monorepo"; },
    release => { release.packages[0].filename = "../../core.tgz"; },
    release => { release.packages[4].resources = release.packages[4].resources.filter(item => item.path !== "dist/sdk-loader.mjs"); },
    release => { release.packages[0].files = release.packages[0].files.filter(item => item.path !== "dist/index.d.ts"); },
    release => { release.packages[0].files.push({ path: "dist/docs/private.md" }); },
    release => { release.packages[0].files.push({ path: "src/runtime.ts" }); },
  ];
  for (const mutate of mutations) {
    const release = candidate();
    mutate(release);
    assert.throws(() => validatePublicationManifest(release, { revision, version }));
  }
});

test("publication candidates reject preview mode without producing artifacts", async () => {
  const output = await mkdtemp(join(tmpdir(), "muha-invalid-candidate-"));
  try {
    const result = spawnSync(process.execPath,
      [join(root, "scripts/pack-local-release.mjs"), "--candidate", "--preview", "--output", output],
      { cwd: root, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /A preview cannot be a publication candidate/);
    assert.deepEqual(await readdir(output), []);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test("public registry metadata never makes the root workspace publishable", async () => {
  const workspace = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(workspace.private, true);
  assert.ok(workspace.scripts["pack:diagnostic"]);
  assert.ok(workspace.scripts["pack:candidate"]);
  for (const directory of workspace.workspaces) {
    const manifest = JSON.parse(await readFile(join(root, directory, "package.json"), "utf8"));
    assert.equal(manifest.private, undefined);
    assert.deepEqual(manifest.publishConfig, { access: "public", registry: "https://registry.npmjs.org/" });
    assert.deepEqual(manifest.files, ["dist"]);
    assert.equal(manifest.bundledDependencies, undefined);
    assert.equal(manifest.bundleDependencies, undefined);
  }
});
