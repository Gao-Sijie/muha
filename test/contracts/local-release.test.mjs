import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { assertClipboardLicenseEvidence } from "../support/clipboard-license-contract.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const coreManifest = JSON.parse(await readFile(
  join(repositoryRoot, "packages/core/package.json"),
  "utf8",
));
const releaseVersion = coreManifest.version;
const expectedTarballs = [
  `muha-sdk-core-${releaseVersion}.tgz`,
  `muha-sdk-codex-adapter-${releaseVersion}.tgz`,
  `muha-sdk-opencode-adapter-${releaseVersion}.tgz`,
  `muha-sdk-pi-adapter-${releaseVersion}.tgz`,
  `muha-sdk-kimi-adapter-${releaseVersion}.tgz`,
  `muha-sdk-agy-adapter-${releaseVersion}.tgz`,
  `muha-sdk-muha-${releaseVersion}.tgz`,
].sort();

test(`the diagnostic V${releaseVersion} packer verifies seven SDK packages, dependencies, licenses and resources`, async () => {
  const output = await mkdtemp(join(tmpdir(), "muha-local-release-"));
  try {
    const result = spawnSync(
      process.execPath,
      [join(repositoryRoot, "scripts", "pack-local-release.mjs"), "--preview", "--output", output],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    assert.equal(result.status, 0, [result.stdout, result.stderr].filter(Boolean).join("\n"));

    const entries = (await readdir(output)).sort();
    assert.deepEqual(entries, ["README.md", "SHA256SUMS", "release.json", ...expectedTarballs].sort());

    const readme = await readFile(join(output, "README.md"), "utf8");
    assert.match(readme, new RegExp(`^# Muha SDK diagnostic packages V${escapeRegExp(releaseVersion)}$`, "m"));
    assert.match(readme, /seven-package diagnostic set/);
    assert.doesNotMatch(readme, /muha-orchestrator/);
    assert.match(readme, /sha256sum --check SHA256SUMS/);
    assert.match(readme, /npm install/);
    assert.match(readme, /npm ci/);
    assert.doesNotMatch(readme, /npm install --offline/);
    assert.match(readme, /package-specific usage/);
    assert.match(readme, new RegExp(`muha-sdk-core-${escapeRegExp(releaseVersion)}\\.tgz`));
    assert.doesNotMatch(readme, /\{\{[A-Z_]+\}\}/);

    const release = JSON.parse(await readFile(join(output, "release.json"), "utf8"));
    assert.equal(release.version, releaseVersion);
    assert.equal(release.delivery, "diagnostic-npm-tarballs");
    assert.equal(release.candidate, false, "test packages cannot pretend to be an immutable candidate");
    assert.equal(release.source.lockfileSha256, createHash("sha256").update(await readFile(join(repositoryRoot, "package-lock.json"))).digest("hex"));
    assert.ok(release.source.revision === null || /^[a-f0-9]{40}$/.test(release.source.revision));
    assert.ok(release.dependencies.nodes.length > 0);
    assert.ok(release.dependencies.edges.length > 0);
    assert.equal(release.dependencies.packageHooks["@muha-sdk/pi-adapter"].prepack.command,
      "node scripts/build-sdk.mjs --check");
    assert.ok(release.dependencies.nodes.every(node => node.license && node.integrity));
    assert.ok(release.dependencies.nodes.some(node => node.name === "@agentclientprotocol/sdk" && node.version === "1.4.0"));
    assert.deepEqual(release.dependencies.licenseBlockers, []);
    assertClipboardLicenseEvidence(release.dependencies);
    assert.match(readme, /PREVIEW.*not an acceptance candidate/);
    assert.deepEqual(release.packages.map(({ filename }) => filename).sort(), expectedTarballs);
    assert.deepEqual(
      release.packages.map(({ name }) => name).sort(),
      [
        "@muha-sdk/codex-adapter",
        "@muha-sdk/core",
        "@muha-sdk/kimi-adapter",
        "@muha-sdk/opencode-adapter",
        "@muha-sdk/pi-adapter",
        "@muha-sdk/agy-adapter",
        "@muha-sdk/muha",
      ].sort(),
    );
    assert.equal(
      release.packages.every(({ version }) => version === releaseVersion),
      true,
    );

    const expectedChecksums = [];
    for (const filename of expectedTarballs) {
      const bytes = await readFile(join(output, filename));
      expectedChecksums.push(`${createHash("sha256").update(bytes).digest("hex")}  ${filename}`);
    }
    const piArchive = join(output, `muha-sdk-pi-adapter-${releaseVersion}.tgz`);
    const piFiles = spawnSync("tar", ["-tzf", piArchive], { encoding: "utf8" });
    assert.equal(piFiles.status, 0, piFiles.stderr);
    assert.doesNotMatch(piFiles.stdout, /^package\/node_modules\//m);
    for (const item of release.packages) {
      assert.equal(item.license, "MIT");
      assert.ok(item.resources.some(resource => resource.path === "dist/index.js"));
      for (const resource of item.resources) {
        const packed = spawnSync("tar", ["-xOzf", join(output, item.filename), `package/${resource.path}`]);
        assert.equal(packed.status, 0, packed.stderr?.toString());
        assert.equal(resource.sha256, createHash("sha256").update(packed.stdout).digest("hex"));
        assert.equal(resource.bytes, packed.stdout.length);
      }
    }
    assert.equal(
      await readFile(join(output, "SHA256SUMS"), "utf8"),
      `${expectedChecksums.sort().join("\n")}\n`,
    );
    const corePackage = release.packages.find(({ name }) => name === "@muha-sdk/core");
    assert.ok(corePackage);
    const corePack = spawnSync("tar", ["-tzf", join(output, corePackage.filename)], {
      encoding: "utf8",
    });
    assert.equal(corePack.status, 0, corePack.stderr);
    assert.doesNotMatch(corePack.stdout, /package\/dist\/kimi-mcp\./);

    assert.deepEqual(
      release.packages.map(({ filename, sha256 }) => `${sha256}  ${filename}`).sort(),
      expectedChecksums.sort(),
      "release.json and SHA256SUMS must describe the actual packed bytes",
    );

    const isolatedInstallEnvironment = { ...process.env, MUHA_RELEASE_DIRECTORY: output };
    delete isolatedInstallEnvironment.NODE_TEST_CONTEXT;
    const isolatedInstall = spawnSync(process.execPath,
      [join(repositoryRoot, "test/contracts/package-install.test.mjs")], {
        cwd: repositoryRoot,
        env: isolatedInstallEnvironment,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
    assert.equal(isolatedInstall.status, 0,
      [isolatedInstall.stdout, isolatedInstall.stderr].filter(Boolean).join("\n"));
    assert.match(isolatedInstall.stdout, /(?:✔ |ok \d+ - )an isolated fixture can install Core and all five official Adapters/,
      "the preview tarballs must pass an actual isolated Runtime/Session/Turn install test");
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("the local packer refuses a non-empty final target without changing it", async () => {
  const output = await mkdtemp(join(tmpdir(), "muha-local-release-nonempty-"));
  const marker = join(output, "caller-owned.txt");
  try {
    await writeFile(marker, "preserve me");
    const result = spawnSync(
      process.execPath,
      [join(repositoryRoot, "scripts", "pack-local-release.mjs"), "--output", output],
      { cwd: repositoryRoot, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must not exist or must be empty/);
    assert.equal(await readFile(marker, "utf8"), "preserve me");
    assert.deepEqual(await readdir(output), ["caller-owned.txt"]);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
