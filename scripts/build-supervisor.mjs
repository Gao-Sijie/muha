import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// One reviewed source, independently shipped in each owning package. Core
// never loads a Harness package, and tarball consumers need no C compiler.
const sourceRoot = fileURLToPath(new URL("../packages/core/native/", import.meta.url));
export function buildSupervisor(packageRoot, name) {
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("Build the supervisor on its supported Linux x64 target");
  mkdirSync(resolve(packageRoot, "dist"), { recursive: true });
  // Never expose the linker's incomplete/non-executable output to consumers.
  const staging = mkdtempSync(resolve(packageRoot, ".native-build-"));
  try {
    const candidate = resolve(staging, name);
    execFileSync(process.env.CC ?? "cc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-Wl,--wrap=__libc_start_main",
      resolve(sourceRoot, "supervisor.c"), resolve(sourceRoot, "glibc-startup-compat.c"), "-o", candidate], { stdio: "inherit" });
    const versions = execFileSync("readelf", ["--version-info", candidate], { encoding: "utf8" });
    for (const [, major, minor] of versions.matchAll(/GLIBC_(\d+)\.(\d+)/gu)) {
      if (Number(major) > 2 || (Number(major) === 2 && Number(minor) > 28)) throw new Error("Supervisor would raise the existing glibc 2.28 requirement");
    }
    for (const [source, shipped] of [["supervisor.c", `${name}.c`], ["glibc-startup-compat.c", `${name}-glibc-compat.c`]]) {
      copyFileSync(resolve(sourceRoot, source), resolve(staging, shipped));
      renameSync(resolve(staging, shipped), resolve(packageRoot, "dist", shipped));
    }
    renameSync(candidate, resolve(packageRoot, "dist", name));
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
