import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packages = [
  ["core", "@muha-sdk/core"],
  ["codex-adapter", "@muha-sdk/codex-adapter"],
  ["opencode-adapter", "@muha-sdk/opencode-adapter"],
  ["kimi-adapter", "@muha-sdk/kimi-adapter"],
  ["pi-adapter", "@muha-sdk/pi-adapter"],
  ["agy-adapter", "@muha-sdk/agy-adapter"],
  ["muha", "muha"],
];

async function readManifest(directory) {
  const contents = await readFile(
    new URL(`../../packages/${directory}/package.json`, import.meta.url),
    "utf8",
  );
  return JSON.parse(contents);
}

const coreManifest = await readManifest("core");
const releaseVersion = coreManifest.version;

test("the official packages share one installable ESM contract", async () => {
  const manifests = await Promise.all(
    packages.map(async ([directory, expectedName]) => {
      const manifest = await readManifest(directory);
      assert.equal(manifest.name, expectedName);
      assert.equal(manifest.type, "module");
      assert.equal(manifest.private, undefined);
      assert.equal(manifest.engines.node, ">=22.20.0");
      assert.deepEqual(
        manifest.files,
        directory === "muha" ? ["dist", "README.zh-CN.md"] : ["dist"],
      );
      assert.deepEqual(manifest.publishConfig, { access: "public", registry: "https://registry.npmjs.org/" });
      assert.deepEqual(manifest.exports["."], {
        types: "./dist/index.d.ts",
        default: "./dist/index.js",
      });
      assert.equal(manifest.main, undefined);
      return manifest;
    }),
  );

  assert.deepEqual(
    manifests.map(({ version }) => version),
    packages.map(() => releaseVersion),
  );

  assert.deepEqual(manifests[0].dependencies, {
    "@agentclientprotocol/sdk": "1.4.0",
    "add-mcp": "2.0.0",
    skills: "1.5.21",
    zod: "4.6.5",
  });
  for (const adapter of [manifests[1], manifests[3]]) {
    assert.deepEqual(adapter.dependencies, {
      "@muha-sdk/core": releaseVersion,
    });
  }
  assert.deepEqual(manifests[2].dependencies, {
    "@muha-sdk/core": releaseVersion,
    "@opencode/client": "2.0.11",
    "jsonc-parser": "3.3.1",
  });
  assert.deepEqual(manifests[4].dependencies, {
    "@muha-sdk/core": releaseVersion,
    "@earendil-works/pi-coding-agent": "1.0.4",
  });
  assert.equal(manifests[4].bundledDependencies, undefined);
  assert.equal(manifests[4].bundleDependencies, undefined);
  assert.deepEqual(manifests[5].dependencies, { "@muha-sdk/core": releaseVersion });
  assert.deepEqual(manifests[6].dependencies,
    Object.fromEntries(packages.slice(0, 6).map(([, name]) => [name, releaseVersion])));
  assert.equal(manifests[6].optionalDependencies, undefined);
  assert.equal(manifests[6].peerDependencies, undefined);
});

test("every official package tarball contains declarations and one ESM build", () => {
  for (const [directory] of packages) {
    const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: new URL(`../../packages/${directory}`, import.meta.url),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(result.status, 0, result.stderr);

    const [{ files }] = JSON.parse(result.stdout);
    const paths = files.map(({ path }) => path);
    assert.ok(paths.includes("LICENSE"), `${directory} has its MIT license text`);
    assert.ok(paths.includes("README.md"), `${directory} has package documentation`);
    if (directory === "muha") assert.ok(paths.includes("README.zh-CN.md"), "muha ships the Chinese guide");
    assert.ok(paths.includes("package.json"), `${directory} has its manifest`);
    assert.ok(paths.includes("dist/index.js"), `${directory} has ESM output`);
    if (directory === "codex-adapter") {
      const observer = files.find(file => file.path === "dist/codex-observer-worker.js");
      assert.ok(observer, "Codex ships its private native observer executable");
      assert.ok(observer.mode & 0o111, "the bridge can execute the packaged observer");
      assert.ok(paths.includes("dist/codex-observer-wire.js"));
    }
    assert.ok(
      paths.includes("dist/index.d.ts"),
      `${directory} has TypeScript declarations`,
    );
    if (directory === "core" || directory === "kimi-adapter") {
      assert.ok(
        paths.includes("dist/workspace-mcp-worker.js"),
        `${directory} contains its owned MCP Workspace worker`,
      );
    }
    if (directory === "codex-adapter" || directory === "opencode-adapter") {
      assert.equal(
        paths.includes("dist/workspace-mcp-worker.js"),
        false,
        `${directory} reuses Core's MCP Workspace worker`,
      );
    }
    const ownPaths = paths.filter(path => !path.startsWith("node_modules/"));
    assert.equal(ownPaths.some((path) => path.endsWith(".cjs")), false);
    assert.equal(ownPaths.some((path) => path.endsWith(".tsbuildinfo")), false);
  }
});
