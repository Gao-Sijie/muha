import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageRoot = new URL("../../packages/pi-adapter/", import.meta.url);

test("Pi Adapter declares the pinned SDK without redistributing its dependency tree", async () => {
  const manifest = JSON.parse(await readFile(new URL("package.json", packageRoot), "utf8"));
  assert.equal(manifest.dependencies["@earendil-works/pi-coding-agent"], "1.0.4");
  assert.equal(manifest.bundledDependencies, undefined);
  assert.equal(manifest.bundleDependencies, undefined);

  const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], {
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
