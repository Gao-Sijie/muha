import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readReleaseSource } from "../../scripts/release-source.mjs";

test("candidate provenance distinguishes committed source, dirty inputs and untracked scratch evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-release-source-"));
  const git = (...args) => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    assert.deepEqual(await readReleaseSource(root), { revision: null, tree: null, dirty: true });
    git("init", "-q");
    await writeFile(join(root, "source.js"), "export const value = 1;\n");
    git("add", "source.js");
    git("-c", "user.name=Muha fixture", "-c", "user.email=fixture@invalid.test", "commit", "-qm", "fixture source");
    const clean = await readReleaseSource(root);
    assert.deepEqual(clean, { revision: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"), dirty: false });
    await mkdir(join(root, ".scratch"));
    await writeFile(join(root, ".scratch", "evidence.txt"), "not a build input\n");
    assert.deepEqual(await readReleaseSource(root), clean);
    await writeFile(join(root, "new-module.js"), "export const other = 2;\n");
    assert.equal((await readReleaseSource(root)).dirty, true, "untracked implementation must not be omitted");
    await rm(join(root, "new-module.js"));
    await writeFile(join(root, "source.js"), "export const value = 2;\n");
    assert.equal((await readReleaseSource(root)).dirty, true);
    git("add", "source.js");
    assert.equal((await readReleaseSource(root)).dirty, true, "staging is not committing");
  } finally { await rm(root, { recursive: true, force: true }); }
});
