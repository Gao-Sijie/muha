import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MUHA_DELIVERY_PACKAGES } from "./delivery-manifest.mjs";

export async function readReleaseVersion(root) {
  const manifests = await Promise.all(MUHA_DELIVERY_PACKAGES.map(async delivery =>
    JSON.parse(await readFile(join(root, "packages", delivery.directory, "package.json"), "utf8"))));
  const version = manifests[0].version;
  if (!/^\d+\.\d+\.\d+$/.test(version) || manifests.some((manifest, index) =>
    manifest.version !== version || manifest.name !== MUHA_DELIVERY_PACKAGES[index].packageName)) {
    throw new Error("Release source must identify one stable official SDK cohort");
  }
  return version;
}
