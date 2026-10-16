import { spawnNpmSync } from "../../scripts/npm-command.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageRoot = new URL("../../packages/pi-adapter/", import.meta.url);

test("Pi Adapter declares the pinned SDK without redistributing its dependency tree", async () => {
  const manifest = JSON.parse(await readFile(new URL("package.json", packageRoot), "utf8"));
  assert.equal(manifest.dependencies["@earendil-works/pi-coding-agent"], "1.2.0");
  assert.equal(manifest.dependencies["@earendil-works/pi-codemode"], ">=1.0.4");
  assert.equal(manifest.bundledDependencies, undefined);
  assert.equal(manifest.bundleDependencies, undefined);

  const packed = spawnNpmSync(["pack", "--dry-run", "--json"], {
    cwd: packageRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(packed.status, 0, packed.stderr || packed.stdout);
  const [{ files }] = JSON.parse(packed.stdout);
  const paths = files.map(file => file.path);
  for (const required of ["dist/ordered-agent-session.mjs", "dist/sdk-patch.json", "dist/PI-SDK-LICENSE", "dist/sdk-worker.mjs"]) {
    assert.ok(paths.includes(required), `Pi artifact lacks ${required}`);
  }
  assert.equal(paths.some(path => path.startsWith("node_modules/")), false,
    "Pi artifact must not carry the SDK or any of its transitive dependencies");
});

test("Pi's unbounded codemode declaration retains the upstream aligned SDK requirement", async () => {
  const manifest = JSON.parse(await readFile(new URL("package.json", packageRoot), "utf8"));
  const lock = JSON.parse(await readFile(new URL("../../package-lock.json", packageRoot), "utf8"));
  assert.deepEqual(lock.packages["packages/pi-adapter"].dependencies, manifest.dependencies);
  assert.equal(lock.packages["node_modules/@earendil-works/pi-coding-agent"].version, "1.2.0");
  assert.equal(lock.packages["node_modules/@earendil-works/pi-codemode"].version, "1.2.0");
  assert.equal(lock.packages["node_modules/@earendil-works/pi-coding-agent"]
    .dependencies["@earendil-works/pi-codemode"], "^1.2.0",
    "Muha's direct declaration must not rewrite the upstream SDK's own requirements");
  const readme = await readFile(new URL("README.md", packageRoot), "utf8");
  for (const statement of ["pi-codemode", ">=1.0.4", "no upper bound", "not a guarantee", "independent installation"]) {
    assert.ok(readme.includes(statement), `Pi dependency boundary is undocumented: ${statement}`);
  }
});
