import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

// Inspect the archive itself: npm pack may normalize file modes independently
// of the source tree that the delivery audit inspected.
export function inspectPackedResource(archive, resourcePath) {
  const entry = `package/${resourcePath}`;
  const extracted = spawnSync("tar", ["-xOzf", archive, entry], { maxBuffer: 16 * 1024 * 1024 });
  const listing = spawnSync("tar", ["-tvzf", archive, entry],
    { encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (extracted.status !== 0 || listing.status !== 0) {
    throw new Error(`Cannot inspect packed resource: ${entry}`);
  }
  const permissions = listing.stdout.trim().split(/\s+/, 1)[0];
  if (!/^-(?:[r-][w-][x-]){3}$/.test(permissions)) {
    throw new Error(`Unsupported packed resource mode: ${entry}`);
  }
  let mode = 0;
  for (let index = 0; index < 3; index++) {
    const triplet = permissions.slice(1 + index * 3, 4 + index * 3);
    mode = mode * 8 + (triplet[0] === "r" ? 4 : 0) +
      (triplet[1] === "w" ? 2 : 0) + (triplet[2] === "x" ? 1 : 0);
  }
  return { bytes: extracted.stdout, mode };
}

export function assertPackedResourceMatches(archive, resource, packageName) {
  const packed = inspectPackedResource(archive, resource.path);
  if (packed.bytes.length !== resource.bytes || packed.mode !== resource.mode ||
      createHash("sha256").update(packed.bytes).digest("hex") !== resource.sha256) {
    throw new Error(`${packageName}: packed resource differs from audited bytes or mode: ${resource.path}`);
  }
}
