import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assertPackedResourceMatches, inspectPackedResource } from "../../scripts/packed-resource.mjs";

test("artifact inspection reports executable mode from tarball, not source assumptions", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-packed-mode-"));
  try {
    await mkdir(join(root, "package/dist"), { recursive: true });
    const entry = join(root, "package/dist/worker.js");
    await writeFile(entry, "worker bytes\n");
    await chmod(entry, 0o644);
    const plain = join(root, "plain.tgz");
    assert.equal(spawnSync("tar", ["-czf", plain, "package/dist/worker.js"], { cwd: root }).status, 0);
    await chmod(entry, 0o755);
    const executable = join(root, "executable.tgz");
    assert.equal(spawnSync("tar", ["-czf", executable, "package/dist/worker.js"], { cwd: root }).status, 0);
    assert.deepEqual(inspectPackedResource(plain, "dist/worker.js"),
      { bytes: Buffer.from("worker bytes\n"), mode: 0o644 });
    assert.deepEqual(inspectPackedResource(executable, "dist/worker.js"),
      { bytes: Buffer.from("worker bytes\n"), mode: 0o755 });
    assert.throws(() => assertPackedResourceMatches(executable, {
      path: "dist/worker.js", bytes: "worker bytes\n".length, mode: 0o755,
      sha256: "0".repeat(64),
    }, "fixture-parent"), /fixture-parent: packed resource differs from audited bytes or mode/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
