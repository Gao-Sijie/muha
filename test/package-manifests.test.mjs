import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packages = [
  ["core", "@muha-sdk/core"],
  ["codex-adapter", "@muha-sdk/codex-adapter"],
  ["opencode-adapter", "@muha-sdk/opencode-adapter"],
  ["kimi-adapter", "@muha-sdk/kimi-adapter"],
];

async function readManifest(directory) {
  return JSON.parse(await readFile(
    new URL(`../packages/${directory}/package.json`, import.meta.url),
    "utf8",
  ));
}

const coreManifest = await readManifest("core");
const releaseVersion = coreManifest.version;

test("the public packages share one publishable ESM contract", async () => {
  const manifests = await Promise.all(packages.map(async ([directory, expectedName]) => {
    const manifest = await readManifest(directory);
    assert.equal(manifest.name, expectedName);
    assert.equal(manifest.version, releaseVersion);
    assert.notEqual(manifest.private, true);
    assert.equal(manifest.type, "module");
    assert.equal(manifest.engines.node, ">=22.20.0");
    assert.deepEqual(manifest.files, ["dist"]);
    assert.deepEqual(manifest.publishConfig, { access: "public" });
    assert.equal(manifest.license, "MIT");
    assert.deepEqual(manifest.repository, {
      type: "git",
      url: "git+https://github.com/Gao-Sijie/muha.git",
      directory: `packages/${directory}`,
    });
    assert.deepEqual(manifest.bugs, { url: "https://github.com/Gao-Sijie/muha/issues" });
    assert.equal(manifest.homepage, "https://github.com/Gao-Sijie/muha#readme");
    assert.deepEqual(manifest.exports["."], {
      types: "./dist/index.d.ts",
      default: "./dist/index.js",
    });
    return manifest;
  }));

  assert.deepEqual(manifests[0].dependencies, {
    "add-mcp": "2.0.0",
    skills: "1.5.21",
  });
  for (const adapter of manifests.slice(1)) {
    assert.deepEqual(adapter.dependencies, { "@muha-sdk/core": releaseVersion });
  }
});

test("each public tarball contains its package entrypoints and metadata", () => {
  for (const [directory] of packages) {
    const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: new URL(`../packages/${directory}`, import.meta.url),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const [{ files }] = JSON.parse(result.stdout);
    const paths = files.map(({ path }) => path);
    for (const required of ["LICENSE", "README.md", "package.json", "dist/index.js", "dist/index.d.ts"]) {
      assert.ok(paths.includes(required), `${directory} is missing ${required}`);
    }
    assert.equal(paths.some((path) => path.endsWith(".tsbuildinfo")), false);
    assert.equal(paths.some((path) => path.endsWith(".ts")), false);
    if (directory === "core" || directory === "kimi-adapter") {
      assert.ok(paths.includes("dist/workspace-mcp-worker.js"));
    }
  }
});
