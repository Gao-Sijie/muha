import { spawnSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { assertPiPublicationQualification } from "./publication-qualification.mjs";
import { readPublicationCandidate } from "./publication-candidate.mjs";
import { readReleaseVersion } from "./release-version.mjs";
import { publishedMetadata, verifyInstallMetadata, verifyLatest, verifyPublishedPackage } from "./registry-readback.mjs";

const registry = "https://registry.npmjs.org/";
const root = new URL("../", import.meta.url).pathname;
const directory = new URL("../.scratch/npm-candidate/", import.meta.url).pathname;
const revision = process.env.REVIEWED_REVISION;
if (process.env.GITHUB_ACTIONS !== "true" || process.env.GITHUB_REPOSITORY !== "Gao-Sijie/muha" ||
    process.env.GITHUB_REF !== "refs/heads/main" || process.env.GITHUB_SHA !== revision) {
  throw new Error("Publication requires the reviewed GitHub-hosted source");
}
assertPiPublicationQualification(JSON.parse(await readFile(new URL("./fixtures/sdk-runtime-sha256.json", import.meta.url))));
const version = await readReleaseVersion(root);
const candidate = await readPublicationCandidate(directory, {
  revision, version, manifestSha256: process.env.REVIEWED_MANIFEST_SHA256,
});
const mode = process.argv[2];
if (!["publish", "promote"].includes(mode)) throw new Error("Use publish or promote");
if (!process.env.NODE_AUTH_TOKEN) throw new Error("Configure the short-lived NPM_PUBLISH_TOKEN repository secret first");
const repository = await fetch("https://api.github.com/repos/Gao-Sijie/muha", {
  headers: { "User-Agent": "muha-release" }, signal: AbortSignal.timeout(15000),
});
if (!repository.ok || (await repository.json()).private !== false) {
  throw new Error("The reviewed source repository must be public before npm provenance");
}

function npm(args) {
  const result = spawnSync("npm", args, {
    cwd: directory, encoding: "utf8", timeout: 180000, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`npm command failed; stop and read back the registry before any retry: ${result.stderr}`);
  }
}

if (mode === "publish") {
  for (const item of candidate.packages) {
    // Never retry an upload. Existing immutable versions must pass the same
    // reviewed-byte/source readback as a newly uploaded archive.
    if (!(await publishedMetadata(item))) {
      npm(["publish", item.filename, "--access", "public", "--registry", registry, "--tag", "candidate", "--provenance"]);
    }
    console.log(JSON.stringify(await verifyPublishedPackage(item, revision)));
  }
  for (const item of candidate.packages) await verifyInstallMetadata(item);
  await appendFile(process.env.GITHUB_STEP_SUMMARY,
    `Uploaded and read back all ${candidate.packages.length} candidate versions and both npm install metadata formats. Cold public-Registry consumer acceptance must pass before latest promotion.\n`);
} else {
  for (const item of candidate.packages) console.log(JSON.stringify(await verifyPublishedPackage(item, revision)));
  for (const item of candidate.packages) npm(["dist-tag", "add", `${item.name}@${version}`, "latest", "--registry", registry]);
  for (const item of candidate.packages) await verifyLatest(item);
  await appendFile(process.env.GITHUB_STEP_SUMMARY,
    `Both Node consumer jobs passed. All ${candidate.packages.length} latest tags were promoted and read back; source tag and GitHub Release can now be finalized.\n`);
}
