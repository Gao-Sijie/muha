import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { walk } from "./local-package-walker.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const sorted = object => JSON.stringify(Object.fromEntries(Object.entries(object ?? {}).sort(([a], [b]) => a.localeCompare(b))));

/** Audit actual resolution paths, not one arbitrarily selected version/name.
 * A stale, ignored Pi SDK tree from the former bundle build can shadow the
 * hoisted install in a developer checkout. It is checked byte-for-byte
 * against the locked source, but only packed files define redistribution. */
export async function auditProductionDependencies({ root, packages, lock }) {
  const dependencies = [], edges = [], problems = [], queue = [], seen = new Set();
  const official = new Set(packages.map(item => item.manifest.name));
  const enqueue = (manifest, from) => {
    const names = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]);
    for (const name of names) {
      if (official.has(name)) continue;
      const optional = Object.hasOwn(manifest.optionalDependencies ?? {}, name) ||
        (!Object.hasOwn(manifest.dependencies ?? {}, name) && manifest.peerDependenciesMeta?.[name]?.optional === true);
      queue.push({ name, from, optional, spec: manifest.optionalDependencies?.[name] ?? manifest.dependencies?.[name] ?? manifest.peerDependencies[name],
        kind: Object.hasOwn(manifest.dependencies ?? {}, name) ? "dependency" : Object.hasOwn(manifest.optionalDependencies ?? {}, name) ? "optional" : "peer" });
    }
  };
  for (const { directory, manifest } of packages) enqueue(manifest, join(root, "packages", directory));
  while (queue.length) {
    const edge = queue.shift();
    const located = await walk(edge.from, edge.name);
    const relation = { from: relative(root, edge.from), name: edge.name, spec: edge.spec, kind: edge.kind, optional: edge.optional };
    if (located === undefined) {
      edges.push({ ...relation, status: "absent" });
      if (!edge.optional) problems.push(`${edge.name}: cannot resolve required ${edge.kind} from ${relation.from}`);
      continue;
    }
    const path = await realpath(located);
    const installedPath = relative(root, dirname(path)).split(sep).join("/");
    edges.push({ ...relation, status: "present", path: installedPath });
    if (installedPath.startsWith("../") || installedPath === "..") {
      problems.push(`${edge.name}: resolved outside the audited installation`); continue;
    }
    if (seen.has(path)) continue;
    seen.add(path);
    const bytes = await readFile(path);
    const manifest = JSON.parse(bytes);
    if (manifest.name !== edge.name) problems.push(`${installedPath}: installed name differs from ${edge.name}`);
    let lockPath = installedPath;
    const legacyCopyPrefix = "packages/pi-adapter/node_modules/@earendil-works/pi-coding-agent";
    if (installedPath === legacyCopyPrefix || installedPath.startsWith(`${legacyCopyPrefix}/`)) {
      lockPath = installedPath.slice("packages/pi-adapter/".length);
      const original = await readFile(join(root, lockPath, "package.json")).catch(() => undefined);
      if (original === undefined || !bytes.equals(original)) problems.push(`${installedPath}: stale Pi copy differs from its locked source`);
    }
    const locked = lock.packages?.[lockPath];
    if (!locked) problems.push(`${lockPath}: missing from lockfile`);
    else {
      if (locked.version !== manifest.version) problems.push(`${lockPath}: installed version differs from lockfile`);
      if (typeof locked.integrity !== "string" || !locked.integrity) problems.push(`${lockPath}: lockfile lacks artifact integrity`);
      for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
        // npm removes optional entries from dependencies in some lockfiles.
        const actual = { ...manifest[field] }, expected = { ...locked[field] };
        if (field === "dependencies") for (const key of Object.keys(manifest.optionalDependencies ?? {})) { delete actual[key]; delete expected[key]; }
        if (sorted(actual) !== sorted(expected)) problems.push(`${lockPath}: ${field} differ from lockfile`);
      }
    }
    const license = manifest.license ?? manifest.licenses;
    if (license === undefined || license === "" || (Array.isArray(license) && license.length === 0)) problems.push(`${manifest.name}@${manifest.version}: no declared license`);
    const licenseFiles = [];
    for (const entry of await readdir(dirname(path), { withFileTypes: true })) {
      if (!entry.isFile() || !/^(licen[sc]e|copying|notice)([.-]|$)/i.test(entry.name)) continue;
      const licenseBytes = await readFile(join(dirname(path), entry.name));
      licenseFiles.push({ path: entry.name, bytes: licenseBytes.length, sha256: digest(licenseBytes) });
    }
    const installHooks = {};
    // npm synthesizes `node-gyp rebuild` for a package with binding.gyp and
    // no explicit install/preinstall script. It must not evade hook review.
    const binding = await readFile(join(dirname(path), "binding.gyp")).catch(error => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    const reviewedMsgpackrHook = binding === undefined ? false :
      await reviewPinnedMsgpackrHook({ root, directory: dirname(path), manifest, bytes, locked, binding, lock });
    if (binding !== undefined) {
      const implicit = manifest.scripts?.install === undefined && manifest.scripts?.preinstall === undefined;
      installHooks.implicitBindingGyp = { sha256: digest(binding), implicit, reviewed: reviewedMsgpackrHook };
      if (!reviewedMsgpackrHook) problems.push(`${manifest.name}@${manifest.version}: unreviewed ${implicit ? "implicit install hook" : "native binding.gyp"}`);
    }
    for (const phase of ["prepare", "prepack", "preinstall", "install", "postinstall"]) {
      const command = manifest.scripts?.[phase];
      if (typeof command !== "string") continue;
      // Registry tarballs carry prepare/prepack scripts as metadata, but npm
      // does not execute them during consumer installation. Non-registry
      // sources may invoke packaging lifecycle; unresolved provenance fails closed.
      const installExecuted = phase === "preinstall" || phase === "install" || phase === "postinstall" ||
        (["prepare", "prepack"].includes(phase) && !/^https?:\/\/.*\.tgz(?:\?.*)?$/.test(locked?.resolved ?? ""));
      installHooks[phase] = { command, installExecuted, reviewed: false };
      if (manifest.name === "@google/genai" && manifest.version === "1.52.0" && phase === "preinstall" && command === "echo 'preinstall: no-op'") {
        installHooks[phase].reviewed = true;
      }
      // The pinned protobufjs hook only reads manifests and prints a version
      // scheme warning. It does not download or install a Coding Harness.
      if (manifest.name === "protobufjs" && manifest.version === "7.6.5" && phase === "postinstall" && command === "node scripts/postinstall") {
        const sha256 = digest(await readFile(join(dirname(path), "scripts/postinstall.js")));
        installHooks[phase] = { command, installExecuted, sha256, reviewed: sha256 === "5af8463b97ee8e309b4a2111f9479bacdf0c180de0ca0155527679b1fc6d9e6c" };
      }
      if (phase === "install" && command === "node-gyp-build-optional-packages" && reviewedMsgpackrHook) {
        installHooks[phase].reviewed = true;
      }
      if (installExecuted && !installHooks[phase].reviewed) problems.push(`${manifest.name}@${manifest.version}: unreviewed ${phase} hook`);
    }
    dependencies.push({ name: manifest.name, version: manifest.version, path: installedPath, lockPath,
      integrity: locked?.integrity, resolved: locked?.resolved, manifestSha256: digest(bytes),
      license: license ?? "(missing)", licenseFiles: licenseFiles.sort((a, b) => a.path.localeCompare(b.path)), installHooks });
    enqueue(manifest, dirname(path));
  }
  dependencies.sort((a, b) => a.path.localeCompare(b.path));
  return { dependencies, edges, problems };
}

// This optional native accelerator is pulled in by the pinned OpenCode v2 client.
// Its registry artifact and the exact install path were reviewed in this repo.
// The hook first probes a local prebuilt binary; if absent it may invoke a
// local node-gyp rebuild. Neither reviewed hook script downloads a prebuilt
// binary. A changed artifact, helper, build recipe, or native source fails
// closed; this is not a blanket approval for native install scripts.
async function reviewPinnedMsgpackrHook({ root, directory, manifest, bytes, locked, binding, lock }) {
  if (manifest.name !== "msgpackr-extract" || manifest.version !== "3.0.4" ||
      manifest.scripts?.install !== "node-gyp-build-optional-packages" ||
      digest(bytes) !== "5cc88f0f15a0b54d9bb55b7aba652b792342199d77a8402727b76f0a53f9c2d1" ||
      locked?.integrity !== "sha512-4kmO/MdyUIkLIvTPr8VHLil4AtoKIoniWPIEk5+CDy0xnWC84azhSFmuJ7PxZdsYtiP5kEeQsORAVIeMgxT+Hw==" ||
      digest(binding) !== "72b0856ef1d21c3f2d7f45c92276081414ef653ecfe2d490b1f130a630d47799") return false;
  if (await fileDigest(join(directory, "src/extract.cpp")) !==
      "77c504c7adc96204fcf4aac1d44911e8a372f8b7f19c6d74faf609e5eb2e8de0") return false;
  const helperPath = await walk(directory, "node-gyp-build-optional-packages");
  if (helperPath === undefined) return false;
  const helperDirectory = dirname(helperPath);
  const helperLockPath = relative(root, helperDirectory).split(sep).join("/");
  const helperLock = lock.packages?.[helperLockPath];
  if (helperLock?.integrity !== "sha512-s+w+rBWnpTMwSFbaE0UXsRlg7hU4FjekKU4eyAih5T8nJuNZT1nNsskXpxmeqSK9UzkBl6UgRlnKc8hz8IEqOw==" ||
      await fileDigest(helperPath) !== "939e18b5652b4cd288a9ff263ddd9be1101b0503903794b9f8feb2603461e1a4") return false;
  for (const [file, expected] of Object.entries({
    "bin.js": "b6c3ee58c7199854c80d2a6a7a67292ec6c9be9b6de2125c8f8370afc3c6bff4",
    "build-test.js": "34c19ff8b6675d6d27c63a7df44d77a442805eeea8756d1c89e0264f4a3028f6",
    "index.js": "a7ed0d5ae218a19bdbdf15a590d0893790ddf536313b66a787554693cfaae078",
    "node-gyp-build.js": "21145626bbb3122baf79f196087f05d6f1eeb7b9c65c037ced6940c5c6113440",
  })) {
    if (await fileDigest(join(helperDirectory, file)) !== expected) return false;
  }
  return true;
}

async function fileDigest(path) {
  const bytes = await readFile(path).catch(error => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  return bytes === undefined ? undefined : digest(bytes);
}
