// Offline identity/closure/license/resource audit, independent of npm advisory
// data. All findings are explicit; a successful registry audit cannot mask one.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deliveryResources, MUHA_DELIVERY_PACKAGES } from "./delivery-manifest.mjs";
import { auditProductionDependencies } from "./dependency-audit.mjs";
import { bindDependencyLicenseEvidence } from "./dependency-license-evidence.mjs";

export async function auditLocalDelivery(root = resolve(import.meta.dirname, "..")) {
const workspace = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const lockBytes = await readFile(join(root, "package-lock.json"));
const lock = JSON.parse(lockBytes);
const problems = [], packages = [], resources = [], packageHooks = {};
if (workspace.private !== true) problems.push("the root workspace must remain private");
if (JSON.stringify(workspace.workspaces) !== JSON.stringify(MUHA_DELIVERY_PACKAGES.map(item => `packages/${item.directory}`))) {
  problems.push("the root must contain exactly the six official SDK workspaces");
}
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const sorted = object => JSON.stringify(Object.fromEntries(Object.entries(object ?? {}).sort(([a], [b]) => a.localeCompare(b))));
for (const delivery of MUHA_DELIVERY_PACKAGES) {
  const manifest = JSON.parse(await readFile(join(root, "packages", delivery.directory, "package.json"), "utf8"));
  const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: join(root, "packages", delivery.directory), encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  });
  let bundledFiles = [];
  if (packed.error || packed.status !== 0) {
    problems.push(`${manifest.name}: cannot inspect npm pack file list: ${packed.error?.message ?? packed.stderr}`);
  } else {
    try {
      const result = JSON.parse(packed.stdout);
      if (!Array.isArray(result) || result.length !== 1 || !Array.isArray(result[0].files)) {
        throw new Error("invalid npm pack result");
      }
      const paths = result[0].files.map(file => file.path);
      for (const path of paths) {
        if (path.split("/").includes("docs") || !["package.json", "LICENSE", "README.md"].includes(path) && !path.startsWith("dist/")) {
          problems.push(`${manifest.name}: file outside the publication allowlist: ${path}`);
        }
      }
      bundledFiles = paths.filter(path => path.startsWith("node_modules/"));
      if (bundledFiles.length) problems.push(`${manifest.name}: unexpectedly redistributes node_modules files`);
    } catch (error) { problems.push(`${manifest.name}: invalid npm pack file list: ${error.message}`); }
  }
  packages.push({ directory: delivery.directory, manifest, bundledFiles });
  if (manifest.name !== delivery.packageName) problems.push(`${delivery.directory}: wrong package identity`);
  if (manifest.private !== undefined) problems.push(`${manifest.name}: SDK publication must omit private`);
  if (manifest.publishConfig?.access !== "public" || manifest.publishConfig?.registry !== "https://registry.npmjs.org/") {
    problems.push(`${manifest.name}: must explicitly publish publicly to the npm registry`);
  }
  if (JSON.stringify(manifest.files) !== JSON.stringify(["dist"])) problems.push(`${manifest.name}: unexpected files allowlist`);
  const locked = lock.packages?.[`packages/${delivery.directory}`];
  if (locked?.version !== manifest.version || sorted(locked?.dependencies) !== sorted(manifest.dependencies)) {
    problems.push(`${manifest.name}: workspace lock entry does not match its manifest`);
  }
  if (typeof manifest.license !== "string" || !manifest.license) problems.push(`${manifest.name}: no declared license`);
  const hooks = {};
  for (const phase of ["prepack", "prepare", "postpack", "preinstall", "install", "postinstall"]) {
    const command = manifest.scripts?.[phase];
    if (typeof command !== "string") continue;
    const packExecuted = ["prepack", "prepare", "postpack"].includes(phase);
    const installExecuted = ["preinstall", "install", "postinstall"].includes(phase);
    const reviewed = manifest.name === "@muha-sdk/pi-adapter" && phase === "prepack" &&
      command === "node scripts/build-sdk.mjs --check";
    hooks[phase] = { command, packExecuted, installExecuted, reviewed };
    if ((packExecuted || installExecuted) && !reviewed) problems.push(`${manifest.name}: unreviewed ${phase} lifecycle hook`);
  }
  packageHooks[manifest.name] = hooks;
  const binding = await readFile(join(root, "packages", delivery.directory, "binding.gyp")).catch(error => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (binding !== undefined) problems.push(`${manifest.name}: unreviewed binding.gyp (${digest(binding)})`);
  for (const { path, expectedSha256 } of await deliveryResources(root, delivery)) {
    try {
      const absolute = join(root, "packages", delivery.directory, path);
      const metadata = await stat(absolute);
      if (!metadata.isFile()) throw new Error("not a regular file");
      if ((path.endsWith("-supervisor") || path.endsWith("/codex-observer-worker.js")) && !(metadata.mode & 0o111)) {
        problems.push(`${delivery.directory}/${path}: runtime entry is not executable`);
      }
      const sha256 = digest(await readFile(absolute));
      if (expectedSha256 !== undefined && sha256 !== expectedSha256) problems.push(`${delivery.directory}/${path}: locked runtime resource changed`);
      resources.push({ package: manifest.name, path, bytes: metadata.size, mode: metadata.mode & 0o777, sha256 });
    } catch { problems.push(`${delivery.directory}/${path}: missing required runtime resource`); }
  }
}
const versions = new Set(packages.map(({ manifest }) => manifest.version));
if (versions.size !== 1) problems.push("the six SDK packages do not share one version");
const names = new Set(packages.map(({ manifest }) => manifest.name));
for (const { manifest } of packages) {
  for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
    if (names.has(name) && spec !== manifest.version) problems.push(`${manifest.name}: ${name} must pin the exact delivery version`);
  }
}
const closure = await auditProductionDependencies({ root, packages, lock });
problems.push(...closure.problems);
const licenses = bindDependencyLicenseEvidence(closure.dependencies, resources);
return {
  root, lockfileSha256: digest(lockBytes),
  packages: packages.map(({ directory, manifest, bundledFiles }) => ({ directory, name: manifest.name, version: manifest.version,
    private: manifest.private, license: manifest.license, dependencies: manifest.dependencies ?? {}, bundledFiles })),
  dependencyClosure: licenses.nodes, dependencyEdges: closure.edges, resources, packageHooks,
  upstreamLicenseGaps: licenses.blockers,
  licenseBlockers: packages.some(item => item.bundledFiles.length) ? licenses.blockers : [], problems,
};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
const report = await auditLocalDelivery();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.problems.length || report.licenseBlockers.length) {
  process.stderr.write(`DELIVERY AUDIT FAILED: ${report.problems.length} problem(s), ${report.licenseBlockers.length} license blocker(s)\n`);
  process.exitCode = 1;
}
}
