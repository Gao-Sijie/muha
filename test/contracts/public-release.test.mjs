import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { MUHA_DELIVERY_PACKAGES } from "../../scripts/delivery-manifest.mjs";
import { validateRegistryProvenance } from "../../scripts/registry-provenance.mjs";
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


test("publication entry rejects local execution before reading credentials or contacting npm", () => {
  const result = spawnSync(process.execPath, [new URL("../../scripts/publish-public-release.mjs", import.meta.url).pathname, "publish"], {
    encoding: "utf8", env: { PATH: process.env.PATH, GITHUB_ACTIONS: "false" },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /reviewed GitHub-hosted source/);
});

// npm 11.15.0's GitHub SLSA v1 shape, with deliberate source/subject substitutions.
test("Registry provenance rejects another package, bytes, source, workflow or runner", () => {
  const item = { name: "@muha-sdk/core", version, integrity: "sha512-ZA==" };
  const statement = {
    _type: "https://in-toto.io/Statement/v1", predicateType: "https://slsa.dev/provenance/v1",
    subject: [{ name: "pkg:npm/%40muha-sdk/core@0.1.13", digest: { sha512: "64" } }],
    predicate: { buildDefinition: {
      externalParameters: { workflow: { repository: "https://github.com/Gao-Sijie/muha", path: ".github/workflows/sdk-release.yml", ref: "refs/heads/main" } },
      resolvedDependencies: [{ uri: "git+https://github.com/Gao-Sijie/muha@refs/heads/main", digest: { gitCommit: revision } }],
    }, runDetails: { builder: { id: "https://github.com/actions/runner/github-hosted" } } },
  };
  const envelope = value => ({ attestations: [{ predicateType: "https://slsa.dev/provenance/v1", bundle: { dsseEnvelope: { payload: Buffer.from(JSON.stringify(value)).toString("base64") } } }] });
  validateRegistryProvenance(envelope(statement), item, revision);
  for (const alter of [
    value => { value.subject[0].name = "pkg:npm/%40muha-sdk/pi-adapter@0.1.13"; },
    value => { value.subject[0].digest.sha512 = "65"; },
    value => { value.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = "b".repeat(40); },
    value => { value.predicate.buildDefinition.externalParameters.workflow.path = ".github/workflows/other.yml"; },
    value => { value.predicate.runDetails.builder.id = "https://github.com/actions/runner/self-hosted"; },
  ]) { const changed = structuredClone(statement); alter(changed); assert.throws(() => validateRegistryProvenance(envelope(changed), item, revision)); }
});

// Earlier PASS receipts cannot qualify a newly changed lifecycle implementation.
test("publication refuses a pending Pi runtime even when its historical qualification passed", async () => {
  const { assertPiPublicationQualification } = await import("../../scripts/publication-qualification.mjs");
  const passed = { harness: "pi", sdkVersion: "1.0.4", status: "PASS" };
  assert.doesNotThrow(() => assertPiPublicationQualification({ requalifications: [passed] }));
  for (const status of ["PENDING", "FAIL"]) {
    assert.throws(() => assertPiPublicationQualification({ requalifications: [passed, { ...passed, status }] }), /Latest Pi runtime/);
  }
  assert.throws(() => assertPiPublicationQualification({ requalifications: [] }), /Latest Pi runtime/);
});
