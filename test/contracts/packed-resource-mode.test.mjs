import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";
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
    if (process.platform === "win32") await archiveMode(plain, 0o644);
    await chmod(entry, 0o755);
    const executable = join(root, "executable.tgz");
    assert.equal(spawnSync("tar", ["-czf", executable, "package/dist/worker.js"], { cwd: root }).status, 0);
    if (process.platform === "win32") await archiveMode(executable, 0o755);
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

// NTFS chmod cannot create POSIX archive modes. Set the controlled tar header
// explicitly, then exercise the same inspection of the actual compressed bytes.
async function archiveMode(path, mode) {
  const bytes = gunzipSync(await readFile(path));
  for (let offset = 0; offset + 512 <= bytes.length; ) {
    const header = bytes.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString().replace(/\0.*$/su, "");
    if (name === "package/dist/worker.js") {
      header.write(mode.toString(8).padStart(7, "0") + "\0", 100, 8, "ascii");
      header.fill(32, 148, 156);
      const checksum = header.reduce((sum, value) => sum + value, 0);
      header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
      await writeFile(path, gzipSync(bytes)); return;
    }
    const size = parseInt(header.subarray(124, 136).toString().replace(/\0.*$/su, "").trim() || "0", 8);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error("Controlled tar entry is absent");
}
