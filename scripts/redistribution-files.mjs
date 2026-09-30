import { spawnSync } from "node:child_process";

// Read the archive itself; a manifest or npm's JSON summary is not proof of
// what bytes the release actually redistributes.
export function packedDependencyFiles(archive) {
  const listing = spawnSync("tar", ["-tzf", archive], {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  });
  if (listing.error || listing.status !== 0) {
    throw new Error(`Cannot inspect packed dependency files: ${archive}`);
  }
  return listing.stdout.split("\n")
    .filter(path => path.startsWith("package/node_modules/") && !path.endsWith("/"))
    .map(path => path.slice("package/".length));
}

export function assertNoBundledDependencies(archive, packageName) {
  if (packedDependencyFiles(archive).length) {
    throw new Error(`${packageName}: unexpectedly redistributes node_modules files`);
  }
}
