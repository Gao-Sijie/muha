import { isMainThread } from "node:worker_threads";

import { MuhaError } from "./errors.js";

const supportedNode = [22, 20, 0] as const;

export function assertSupportedHost(): void {
  const observed = parseVersion(process.versions.node);
  if (compareVersions(observed, supportedNode) < 0) {
    throw new MuhaError({
      code: "UNSUPPORTED_RUNTIME",
      message: `Node.js ${process.versions.node} is not supported; expected >=22.20.0`,
      runtime: "node",
      version: process.versions.node,
      supportedRange: ">=22.20.0",
    });
  }

  const report = process.report?.getReport() as
    | { header?: { glibcVersionRuntime?: string } }
    | undefined;
  const libc = report?.header?.glibcVersionRuntime ? "glibc" : "unknown";
  if (
    !isMainThread ||
    process.arch !== "x64" ||
    !(process.platform === "win32" || (process.platform === "linux" && libc === "glibc"))
  ) {
    throw new MuhaError({
      code: "UNSUPPORTED_PLATFORM",
      message: "Muha requires a Linux x64 glibc or Windows x64 main-thread process",
      platform: process.platform,
      architecture: process.arch,
      libc,
    });
  }
}

function parseVersion(version: string): readonly number[] {
  return version.split(".").slice(0, 3).map(Number);
}

function compareVersions(
  left: readonly number[],
  right: readonly number[],
): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
