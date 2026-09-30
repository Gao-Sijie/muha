import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assertNoBundledDependencies, packedDependencyFiles } from "../../scripts/redistribution-files.mjs";

test("a packed dependency is visible in the archive even when the parent manifest names only one package", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-redistribution-"));
  try {
    const child = join(root, "node_modules", "fixture-child");
    await mkdir(child, { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({
      name: "fixture-parent", version: "1.0.0", dependencies: { "fixture-child": "1.0.0" },
      bundledDependencies: ["fixture-child"],
    }));
    await writeFile(join(child, "package.json"), JSON.stringify({ name: "fixture-child", version: "1.0.0" }));
    await writeFile(join(child, "index.js"), "module.exports = 1;\n");
    const packed = spawnSync("npm", ["pack", "--json", "--pack-destination", root], {
      cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(packed.status, 0, packed.stderr || packed.stdout);
    const [{ filename }] = JSON.parse(packed.stdout);
    assert.deepEqual(packedDependencyFiles(join(root, filename)).sort(),
      ["node_modules/fixture-child/index.js", "node_modules/fixture-child/package.json"]);
    assert.throws(() => assertNoBundledDependencies(join(root, filename), "fixture-parent"),
      /fixture-parent: unexpectedly redistributes node_modules files/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
