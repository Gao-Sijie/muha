import { rm } from "node:fs/promises";
import { resolve } from "node:path";

import { MUHA_DELIVERY_PACKAGES } from "./delivery-manifest.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

await Promise.all(MUHA_DELIVERY_PACKAGES.map(({ directory }) =>
  rm(resolve(repositoryRoot, "packages", directory, "dist"), {
    recursive: true,
    force: true,
  })));
