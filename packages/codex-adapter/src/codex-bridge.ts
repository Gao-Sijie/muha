import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";

// The ADR-0137 exception covers this exact npm bridge artifact, not arbitrary
// programs named codex-acp or a future experimental app-server surface.
const bridgeName = "@agentclientprotocol/codex-acp";
const bridgeVersion = "1.12.0";
const bridgeSha256 = "f45a64dc3a994556ebdb688dc8d59b86945a9b2f940a3e3e545739dd265a7cc5";

export async function resolvePinnedCodexBridge(environment: Readonly<Record<string, string | undefined>>) {
  const path = (Object.hasOwn(environment, "PATH") ? environment.PATH : process.env.PATH) ?? "";
  let entry: string | undefined;
  for (const directory of path.split(delimiter).filter(Boolean)) {
    const candidate = join(directory, "codex-acp");
    try { await access(candidate, constants.X_OK); entry = await realpath(candidate); break; }
    catch { /* Match executable lookup without installing a prerequisite. */ }
  }
  const reject = () => ({ code: "HARNESS_ERROR", harness: "codex", command: "codex-acp", operation: "initialize",
    message: `Existing verified ${bridgeName}@${bridgeVersion} npm executable is required on PATH; Muha does not install or replace a bridge or Harness`, retryable: false } as const);
  if (entry === undefined) throw reject();
  try {
    const root = dirname(dirname(entry));
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    if (manifest.name !== bridgeName || manifest.version !== bridgeVersion || manifest.bin?.["codex-acp"] !== "dist/index.js" ||
        entry !== await realpath(join(root, "dist/index.js"))) throw reject();
    const metadata = await stat(entry);
    if (!metadata.isFile() || metadata.size > 16 * 1024 * 1024 ||
        createHash("sha256").update(await readFile(entry)).digest("hex") !== bridgeSha256) throw reject();
    return { command: process.execPath, prefix: [entry] as readonly string[] };
  } catch { throw reject(); }
}
