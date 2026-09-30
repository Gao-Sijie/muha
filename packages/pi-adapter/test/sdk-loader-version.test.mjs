import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("Pi SDK loader rejects a different installed package version before import", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-pi-version-"));
  const dist = join(root, "dist");
  const sdk = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
  try {
    await mkdir(join(sdk, "dist", "core"), { recursive: true });
    await mkdir(dist);
    for (const name of ["sdk-loader.mjs", "sdk-patch.json", "ordered-agent-session.mjs"]) {
      await cp(new URL(`../dist/${name}`, import.meta.url), join(dist, name));
    }
    await cp(new URL("../../../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js", import.meta.url),
      join(sdk, "dist", "core", "agent-session.js"));
    await writeFile(join(sdk, "package.json"), JSON.stringify({
      name: "@earendil-works/pi-coding-agent", version: "0.84.3", type: "module",
      exports: { ".": "./dist/index.js" },
    }));
    await writeFile(join(sdk, "dist", "index.js"), 'import "./core/agent-session.js";\n');
    const result = spawnSync(process.execPath, ["--input-type=module"], {
      cwd: root, encoding: "utf8", input: `
        import { loadSdk } from "./dist/sdk-loader.mjs";
        try { await loadSdk(); process.exitCode = 1; }
        catch (error) {
          if (!/Pi SDK version mismatch/.test(error.message)) {
            console.error(error);
            process.exitCode = 1;
          }
        }
      `,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Pi SDK loader reports an absent declared dependency", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-pi-missing-sdk-"));
  const dist = join(root, "dist");
  try {
    await mkdir(dist);
    await cp(new URL("../dist/sdk-loader.mjs", import.meta.url), join(dist, "sdk-loader.mjs"));
    const result = spawnSync(process.execPath, ["--input-type=module"], {
      cwd: root, encoding: "utf8", input: `
        import { loadSdk } from "./dist/sdk-loader.mjs";
        try { await loadSdk(); process.exitCode = 1; }
        catch (error) {
          if (!/Pi SDK dependency is unavailable/.test(error.message)) {
            console.error(error);
            process.exitCode = 1;
          }
        }
      `,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally { await rm(root, { recursive: true, force: true }); }
});
