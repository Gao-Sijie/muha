import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { MUHA_DELIVERY_PACKAGES } from "./delivery-manifest.mjs";
import { assertPackedResourceMatches } from "./packed-resource.mjs";

const digest = (bytes, algorithm = "sha256", encoding = "hex") =>
  createHash(algorithm).update(bytes).digest(encoding);

// Only explicitly reviewed bytes from a clean source can enter publication.
// Diagnostic manifests are rejected even when their package hashes are valid.
export async function readPublicationCandidate(directory, { revision, version, manifestSha256 }) {
  if (!/^[a-f0-9]{40}$/.test(revision ?? "") || !/^[a-f0-9]{64}$/.test(manifestSha256 ?? "")) {
    throw new Error("Publication requires the reviewed source revision and manifest SHA256");
  }
  const bytes = await readFile(join(directory, "release.json"));
  if (digest(bytes) !== manifestSha256) throw new Error("Candidate manifest differs from reviewed bytes");
  const release = JSON.parse(bytes);
  validatePublicationManifest(release, { revision, version });
  const expectedEntries = ["README.md", "SHA256SUMS", "release.json", ...release.packages.map(item => item.filename)].sort();
  if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify(expectedEntries)) {
    throw new Error("Candidate directory contains unexpected or missing files");
  }
  for (const item of release.packages) {
    const archive = join(directory, item.filename);
    const metadata = await lstat(archive);
    if (!metadata.isFile()) throw new Error(`${item.name}: tarball must be a regular file`);
    const packed = await readFile(archive);
    if (digest(packed) !== item.sha256 || `sha512-${digest(packed, "sha512", "base64")}` !== item.integrity) {
      throw new Error(`${item.name}: candidate tarball checksum mismatch`);
    }
    const contents = tar(["-tzf", archive]).trim().split("\n");
    if (tar(["-tvzf", archive]).trim().split("\n").some(line => !line.startsWith("-"))) {
      throw new Error(`${item.name}: archive may contain only regular files`);
    }
    if (JSON.stringify(contents.toSorted()) !== JSON.stringify(item.files.map(file => `package/${file.path}`).toSorted())) {
      throw new Error(`${item.name}: archive files differ from reviewed file evidence`);
    }
    for (const path of contents) {
      if (path.split("/").includes("docs") || !["package/package.json", "package/LICENSE", "package/README.md"].includes(path) && !/^package\/dist\/[^\r\n]+$/.test(path) || path.split("/").includes("..")) {
        throw new Error(`${item.name}: forbidden tarball path ${path}`);
      }
    }
    const manifest = JSON.parse(tar(["-xOzf", archive, "package/package.json"]));
    if (manifest.name !== item.name || manifest.version !== version || manifest.private !== undefined ||
        manifest.publishConfig?.access !== "public" || manifest.publishConfig?.registry !== "https://registry.npmjs.org/" ||
        manifest.repository?.url !== "https://github.com/Gao-Sijie/muha.git" || manifest.type !== "module" ||
        manifest.engines?.node !== ">=22.20.0" || manifest.license !== "MIT" ||
        JSON.stringify(manifest.files) !== JSON.stringify(["dist"]) ||
        manifest.exports?.["."]?.types !== "./dist/index.d.ts" || manifest.exports?.["."]?.default !== "./dist/index.js") {
      throw new Error(`${item.name}: invalid packed publication metadata`);
    }
    if (manifest.name !== "@muha-sdk/core" && manifest.dependencies?.["@muha-sdk/core"] !== version) {
      throw new Error(`${item.name}: packed Core dependency must match the release`);
    }
    for (const resource of item.resources) assertPackedResourceMatches(archive, resource, item.name);
  }
  const checksums = release.packages.map(({ filename, sha256 }) => `${sha256}  ${filename}`).sort().join("\n") + "\n";
  if (await readFile(join(directory, "SHA256SUMS"), "utf8") !== checksums) {
    throw new Error("Candidate checksum file differs from its manifest");
  }
  return release;
}

export function validatePublicationManifest(release, { revision, version }) {
  if (release.delivery !== "public-npm-candidate" || release.candidate !== true) {
    throw new Error("Diagnostic archives are not publication candidates");
  }
  if (release.source?.revision !== revision || release.source?.dirty !== false ||
      !/^[a-f0-9]{40}$/.test(release.source?.tree ?? "") ||
      !/^[a-f0-9]{64}$/.test(release.source?.lockfileSha256 ?? "")) {
    throw new Error("Candidate source does not match the reviewed clean commit");
  }
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "") || release.version !== version) {
    throw new Error("Candidate must use the approved stable version");
  }
  if (!Array.isArray(release.packages) || release.packages.length !== MUHA_DELIVERY_PACKAGES.length) {
    throw new Error("Publication requires exactly the six official SDK packages");
  }
  for (const [index, delivery] of MUHA_DELIVERY_PACKAGES.entries()) {
    const item = release.packages[index];
    if (item.name !== delivery.packageName || item.version !== version ||
        item.filename !== `${delivery.artifactStem}-${version}.tgz`) {
      throw new Error("Candidate identities, versions or ordered package set are invalid");
    }
    if (delivery.role === "adapter" && item.dependencies?.["@muha-sdk/core"] !== version) {
      throw new Error(`${item.name}: Core dependency must pin the release version`);
    }
    if (!/^[a-f0-9]{64}$/.test(item.sha256 ?? "") || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(item.integrity ?? "") ||
        !Array.isArray(item.resources) || !Array.isArray(item.files)) {
      throw new Error(`${item.name}: missing artifact or file evidence`);
    }
    for (const path of ["package.json", "LICENSE", "README.md", ...delivery.requiredFiles]) {
      if (!item.resources.some(resource => resource.path === path) || !item.files.some(file => file.path === path)) {
        throw new Error(`${item.name}: missing required artifact resource ${path}`);
      }
    }
    if (!item.files.some(file => file.path === "dist/index.d.ts")) {
      throw new Error(`${item.name}: missing TypeScript declaration entry`);
    }
    for (const file of item.files) {
      if (file.path.split("/").includes("docs") || !["package.json", "LICENSE", "README.md"].includes(file.path) && !file.path.startsWith("dist/")) {
        throw new Error(`${item.name}: forbidden candidate file ${file.path}`);
      }
    }
  }
}

function tar(args) {
  const result = spawnSync("tar", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`Cannot inspect publication archive: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}
