import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { OFFICIAL_HARNESS_KINDS } from "@muha-sdk/core/internal";
import { MUHA_ADAPTER_DELIVERIES, MUHA_DELIVERY_PACKAGES } from "./delivery-manifest.mjs";
import { auditLocalDelivery } from "./audit-local-delivery.mjs";
import { assertPackedResourceMatches } from "./packed-resource.mjs";
import { assertNoBundledDependencies } from "./redistribution-files.mjs";
import { readReleaseSource } from "./release-source.mjs";
import { readPublicationCandidate } from "./publication-candidate.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const manifests = await Promise.all(MUHA_DELIVERY_PACKAGES.map(async (delivery) => ({
  delivery,
  manifest: JSON.parse(await readFile(
    join(repositoryRoot, "packages", delivery.directory, "package.json"),
    "utf8",
  )),
})));
validateDeliveryManifest(manifests);
const versions = new Set(manifests.map(({ manifest }) => manifest.version));
if (versions.size !== 1) throw new Error("Official Muha packages must share one version");
const [version] = versions;
const args = process.argv.slice(2);
const candidate = args[0] === "--candidate";
if (candidate) args.shift();
const preview = args[0] === "--preview";
if (preview) args.shift();
if (candidate && preview) throw new Error("A preview cannot be a publication candidate");
if (preview && args.length === 0) throw new Error("A preview requires an explicit --output directory");
const outputDirectory = parseOutputDirectory(args, version, candidate);
await assertFinalTargetAvailable(outputDirectory);
const source = await readReleaseSource(repositoryRoot);
if (!preview && (source.revision === null || source.dirty)) {
  throw new Error("Candidate packing requires a clean committed source; use --preview --output for development checks");
}
if (candidate) {
  const policy = spawnSync(process.execPath,
    [join(repositoryRoot, "scripts/check-repository-policy.mjs"), repositoryRoot, "HEAD"],
    { encoding: "utf8" });
  if (policy.status !== 0) throw new Error(`Publication source policy failed: ${policy.stderr}`);
}
const audit = await auditLocalDelivery(repositoryRoot);
if (audit.problems.length) throw new Error(`Delivery audit failed:\n${audit.problems.join("\n")}`);
if (!preview && audit.licenseBlockers.length) {
  throw new Error(`Candidate license audit failed:\n${audit.licenseBlockers.join("\n")}`);
}
await mkdir(dirname(outputDirectory), { recursive: true });
const stagingDirectory = await mkdtemp(join(dirname(outputDirectory), ".muha-release-staging-"));

try {
  const packages = [];
  for (const { delivery, manifest } of manifests) {
    const result = spawnSync(
      "npm",
      ["pack", "--json", "--pack-destination", stagingDirectory],
      {
        cwd: join(repositoryRoot, "packages", delivery.directory),
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          npm_config_audit: "false",
          npm_config_cache: join(repositoryRoot, ".cache", "npm-pack"),
          npm_config_fund: "false",
          npm_config_update_notifier: "false",
        },
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error([
        `Failed to pack ${manifest.name}`,
        result.stdout,
        result.stderr,
      ].filter(Boolean).join("\n"));
    }
    const packed = JSON.parse(result.stdout);
    if (!Array.isArray(packed) || packed.length !== 1 || typeof packed[0].filename !== "string") {
      throw new Error(`npm pack returned an invalid result for ${manifest.name}`);
    }
    const filename = packed[0].filename;
    const expectedFilename = `${delivery.artifactStem}-${manifest.version}.tgz`;
    if (filename !== expectedFilename) {
      throw new Error(`${manifest.name} produced ${filename}; expected ${expectedFilename}`);
    }
    const filePaths = new Set(packed[0].files?.map(({ path }) => path) ?? []);
    const resources = audit.resources.filter(resource => resource.package === manifest.name)
      .map(({ package: _package, ...resource }) => resource);
    for (const { path: required } of resources) {
      if (!filePaths.has(required)) {
        throw new Error(`${manifest.name} artifact is missing required file: ${required}`);
      }
    }
    for (const prefix of delivery.forbiddenFilePrefixes ?? []) {
      const forbidden = [...filePaths].filter((path) => path.startsWith(prefix));
      if (forbidden.length > 0) {
        throw new Error(`${manifest.name} artifact contains forbidden files: ${forbidden.join(", ")}`);
      }
    }
    const bytes = await readFile(join(stagingDirectory, filename));
    assertNoBundledDependencies(join(stagingDirectory, filename), manifest.name);
    for (const resource of resources) {
      assertPackedResourceMatches(join(stagingDirectory, filename), resource, manifest.name);
    }
    packages.push({
      name: manifest.name,
      version: manifest.version,
      filename,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      license: manifest.license,
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      dependencies: manifest.dependencies ?? {},
      files: packed[0].files.map(({ path, size, mode }) => ({ path, bytes: size, mode })),
      resources,
    });
  }

  const checksumLines = packages
    .map(({ filename, sha256 }) => `${sha256}  ${filename}`)
    .sort();
  const filenames = Object.fromEntries(packages.map(({ name, filename }) => [name, filename]));
  const readmeTemplate = await readFile(
    join(repositoryRoot, "scripts", "templates", candidate ? "npm-release-README.template.md" : "local-release-README.template.md"),
    "utf8",
  );
  const readme = renderTemplate(readmeTemplate, {
    CANDIDATE_STATUS: preview ? "PREVIEW — not an acceptance candidate." : candidate ? "Committed npm publication candidate; not yet published or accepted from the registry." : "Committed diagnostic build — not a release or consumer delivery.",
    VERSION: version,
    CORE_FILENAME: requireFilename(filenames, "@muha-sdk/core"),
    CODEX_FILENAME: requireFilename(filenames, "@muha-sdk/codex-adapter"),
    OPENCODE_FILENAME: requireFilename(filenames, "@muha-sdk/opencode-adapter"),
    KIMI_FILENAME: requireFilename(filenames, "@muha-sdk/kimi-adapter"),
    PI_FILENAME: requireFilename(filenames, "@muha-sdk/pi-adapter"),
    AGY_FILENAME: requireFilename(filenames, "@muha-sdk/agy-adapter"),
    MUHA_FILENAME: requireFilename(filenames, "@muha-sdk/muha"),
  });
  await writeFile(join(stagingDirectory, "README.md"), readme, { mode: 0o600 });
  await writeFile(join(stagingDirectory, "SHA256SUMS"), `${checksumLines.join("\n")}\n`, {
    mode: 0o600,
  });
  await writeFile(join(stagingDirectory, "release.json"), `${JSON.stringify({
    version,
    delivery: candidate ? "public-npm-candidate" : "diagnostic-npm-tarballs",
    candidate,
    source: { ...source, lockfileSha256: audit.lockfileSha256 },
    dependencies: { nodes: audit.dependencyClosure, edges: audit.dependencyEdges,
      packageHooks: audit.packageHooks, licenseBlockers: audit.licenseBlockers,
      upstreamLicenseGaps: audit.upstreamLicenseGaps },
    packages,
  }, null, 2)}\n`, { mode: 0o600 });

  const expectedEntries = [
    ...packages.map(({ filename }) => filename),
    "README.md",
    "SHA256SUMS",
    "release.json",
  ].sort();
  const actualEntries = (await readdir(stagingDirectory)).sort();
  if (JSON.stringify(actualEntries) !== JSON.stringify(expectedEntries)) {
    throw new Error(`Unexpected staged release contents: ${actualEntries.join(", ")}`);
  }
  if (candidate) {
    await readPublicationCandidate(stagingDirectory, {
      revision: source.revision, version,
      manifestSha256: createHash("sha256").update(await readFile(join(stagingDirectory, "release.json"))).digest("hex"),
    });
  }

  const finalSource = await readReleaseSource(repositoryRoot);
  const finalLockSha256 = createHash("sha256").update(await readFile(join(repositoryRoot, "package-lock.json"))).digest("hex");
  if (JSON.stringify(finalSource) !== JSON.stringify(source) || finalLockSha256 !== audit.lockfileSha256) {
    throw new Error("Release source changed while packing; no candidate was published");
  }

  await removeEmptyFinalTarget(outputDirectory);
  await rename(stagingDirectory, outputDirectory);
  process.stdout.write(`${outputDirectory}\n`);
} catch (error) {
  await rm(stagingDirectory, { recursive: true, force: true });
  throw error;
}

function parseOutputDirectory(args, version, candidate) {
  if (args.length === 0) return join(repositoryRoot, "dist", `v${version}${candidate ? "-candidate" : ""}`);
  if (args.length === 2 && args[0] === "--output" && args[1].length > 0) {
    return resolve(repositoryRoot, args[1]);
  }
  throw new Error("Usage: pack-local-release.mjs [--candidate | --preview] [--output <directory>]");
}

async function assertFinalTargetAvailable(path) {
  try {
    const metadata = await stat(path);
    if (!metadata.isDirectory()) throw new Error(`Release target is not a directory: ${path}`);
    const entries = await readdir(path);
    if (entries.length > 0) {
      throw new Error(`Release target must not exist or must be empty: ${path}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function removeEmptyFinalTarget(path) {
  try {
    await rmdir(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function validateDeliveryManifest(entries) {
  if (entries.length !== MUHA_DELIVERY_PACKAGES.length) {
    throw new Error("Delivery manifest package count changed during loading");
  }
  const adapters = MUHA_ADAPTER_DELIVERIES.map(({ harness }) => harness);
  if (JSON.stringify(adapters) !== JSON.stringify(OFFICIAL_HARNESS_KINDS)) {
    throw new Error("Delivery Adapter set does not match Core Official Harness Set");
  }
  for (const entry of entries) {
    if (entry.manifest.name !== entry.delivery.packageName) {
      throw new Error(
        `${entry.delivery.directory} package identity is ${entry.manifest.name}; ` +
        `expected ${entry.delivery.packageName}`,
      );
    }
  }
}

function requireFilename(filenames, packageName) {
  const filename = filenames[packageName];
  if (typeof filename !== "string") throw new Error(`Missing packed filename for ${packageName}`);
  return filename;
}

function renderTemplate(template, replacements) {
  let rendered = template;
  for (const [name, value] of Object.entries(replacements)) {
    rendered = rendered.replaceAll(`{{${name}}}`, value);
  }
  const unresolved = rendered.match(/\{\{[A-Z_]+\}\}/g);
  if (unresolved) {
    throw new Error(`Unresolved local release README placeholders: ${unresolved.join(", ")}`);
  }
  return rendered.endsWith("\n") ? rendered : `${rendered}\n`;
}
