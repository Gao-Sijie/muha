import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

test("delivery dependency audit visits distinct installed versions and checks the actual lock paths", async () => {
  const { auditProductionDependencies } = await import("../../scripts/dependency-audit.mjs");
  const root = await mkdtemp(join(tmpdir(), "muha-audit-closure-"));
  const lock = { packages: {} };
  const put = async (path, manifest) => {
    await mkdir(join(root, path), { recursive: true });
    await writeFile(join(root, path, "package.json"), JSON.stringify(manifest));
    lock.packages[path] = { ...manifest, integrity: "sha512-test", resolved: "https://registry.npmjs.org/fixture" };
  };
  try {
    const manifest = { name: "@muha-sdk/core", version: "1.0.0", dependencies: { parent: "1.0.0", shared: "1.0.0" } };
    await put("packages/core", manifest);
    await put("node_modules/parent", { name: "parent", version: "1.0.0", license: "MIT", dependencies: { shared: "2.0.0" } });
    await put("node_modules/shared", { name: "shared", version: "1.0.0", license: "MIT" });
    await put("node_modules/parent/node_modules/shared", { name: "shared", version: "2.0.0" });
    const input = { root, packages: [{ directory: "core", manifest }], lock };
    const result = await auditProductionDependencies(input);
    assert.deepEqual(result.dependencies.filter(item => item.name === "shared").map(item => item.version).sort(), ["1.0.0", "2.0.0"]);
    assert.ok(result.problems.some(problem => /shared@2\.0\.0.*license/.test(problem)));
    delete lock.packages["node_modules/parent"];
    const missing = await auditProductionDependencies(input);
    assert.ok(missing.problems.some(problem => /node_modules\/parent.*lockfile/.test(problem)));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("delivery dependency audit resolves required peers and records absent optional edges", async () => {
  const { auditProductionDependencies } = await import("../../scripts/dependency-audit.mjs");
  const root = await mkdtemp(join(tmpdir(), "muha-audit-peers-"));
  try {
    const manifest = { name: "@muha-sdk/core", version: "1.0.0", dependencies: { child: "1.0.0" } };
    const child = { name: "child", version: "1.0.0", license: "MIT", peerDependencies: { required: "1.0.0", optional: "1.0.0" }, peerDependenciesMeta: { optional: { optional: true } } };
    await mkdir(join(root, "node_modules/child"), { recursive: true });
    await writeFile(join(root, "node_modules/child/package.json"), JSON.stringify(child));
    const result = await auditProductionDependencies({ root, packages: [{ directory: "core", manifest }],
      lock: { packages: { "node_modules/child": { ...child, integrity: "sha512-test" } } } });
    assert.ok(result.problems.some(problem => /required.*cannot resolve/.test(problem)));
    assert.equal(result.problems.some(problem => /optional.*cannot resolve/.test(problem)), false);
    assert.ok(result.edges.some(edge => edge.name === "optional" && edge.optional && edge.status === "absent"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("delivery dependency audit detects npm's implicit binding.gyp install hook", async () => {
  const { auditProductionDependencies } = await import("../../scripts/dependency-audit.mjs");
  const root = await mkdtemp(join(tmpdir(), "muha-audit-binding-"));
  try {
    const manifest = { name: "@muha-sdk/core", version: "1.0.0", dependencies: { native: "1.0.0" } };
    const native = { name: "native", version: "1.0.0", license: "MIT" };
    await mkdir(join(root, "node_modules/native"), { recursive: true });
    await writeFile(join(root, "node_modules/native/package.json"), JSON.stringify(native));
    await writeFile(join(root, "node_modules/native/binding.gyp"), "{ 'targets': [] }\n");
    const result = await auditProductionDependencies({ root,
      packages: [{ directory: "core", manifest }],
      lock: { packages: { "node_modules/native": { ...native, integrity: "sha512-test" } } } });
    assert.ok(result.problems.some(problem => /native@1\.0\.0.*implicit install hook/.test(problem)));
    assert.match(result.dependencies[0].installHooks.implicitBindingGyp.sha256, /^[a-f0-9]{64}$/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("delivery dependency audit records non-install lifecycle scripts without claiming they ran", async () => {
  const { auditProductionDependencies } = await import("../../scripts/dependency-audit.mjs");
  const root = await mkdtemp(join(tmpdir(), "muha-audit-lifecycle-"));
  try {
    const manifest = { name: "@muha-sdk/core", version: "1.0.0", dependencies: { source: "1.0.0" } };
    const source = { name: "source", version: "1.0.0", license: "MIT",
      scripts: { prepare: "npm run build", prepack: "npm test" } };
    await mkdir(join(root, "node_modules/source"), { recursive: true });
    await writeFile(join(root, "node_modules/source/package.json"), JSON.stringify(source));
    const result = await auditProductionDependencies({ root,
      packages: [{ directory: "core", manifest }],
      lock: { packages: { "node_modules/source": { ...source, integrity: "sha512-test",
        resolved: "https://registry.npmjs.org/source/-/source-1.0.0.tgz" } } } });
    assert.equal(result.dependencies[0].installHooks.prepare.command, "npm run build");
    assert.equal(result.dependencies[0].installHooks.prepare.installExecuted, false);
    assert.equal(result.dependencies[0].installHooks.prepack.installExecuted, false);
    assert.equal(result.problems.some(problem => /unreviewed.*prepare|unreviewed.*prepack/.test(problem)), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the pinned optional msgpackr build path is reviewed only at its exact source hashes", async () => {
  const { auditProductionDependencies } = await import("../../scripts/dependency-audit.mjs");
  const sourceRoot = resolve(import.meta.dirname, "../..");
  const root = await mkdtemp(join(tmpdir(), "muha-audit-msgpackr-"));
  const core = { name: "@muha-sdk/core", version: "1.0.0",
    dependencies: { "msgpackr-extract": "3.0.4" } };
  const lock = { packages: {} };
  try {
    await mkdir(join(root, "packages/core"), { recursive: true });
    for (const name of ["msgpackr-extract", "node-gyp-build-optional-packages"]) {
      const path = `node_modules/${name}`;
      await cp(join(sourceRoot, path), join(root, path), { recursive: true });
      lock.packages[path] = (JSON.parse(await readFile(join(sourceRoot, "package-lock.json"), "utf8"))).packages[path];
    }
    const input = { root, packages: [{ directory: "core", manifest: core }], lock };
    const reviewed = await auditProductionDependencies(input);
    const native = reviewed.dependencies.find((item) => item.name === "msgpackr-extract");
    assert.equal(native.installHooks.implicitBindingGyp.reviewed, true);
    assert.equal(native.installHooks.install.reviewed, true);
    assert.equal(reviewed.problems.some((problem) => problem.includes("unreviewed")), false);

    await writeFile(join(root, "node_modules/msgpackr-extract/binding.gyp"), "modified build recipe\n");
    const tampered = await auditProductionDependencies(input);
    assert.equal(tampered.dependencies.find((item) => item.name === "msgpackr-extract")
      .installHooks.install.reviewed, false);
    assert.ok(tampered.problems.some((problem) => problem.includes("msgpackr-extract@3.0.4: unreviewed")));
  } finally { await rm(root, { recursive: true, force: true }); }
});
