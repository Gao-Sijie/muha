import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { createMuhaRuntime } from "@muha-sdk/core";
import { codexAdapter } from "@muha-sdk/codex-adapter";
import { createOfficialHarnessRegistration, readOfficialHarnessRegistration } from "../../packages/core/dist/internal.js";

for (const version of ["0.0.0", "1.12.0"]) {
  test(`Codex refuses an unverified bridge before executing it (manifest ${version})`, { timeout: 4000 }, async () => {
    const { CodexAcpProcess } = await import("../../packages/codex-adapter/dist/codex-acp.js");
    const root = await mkdtemp(join(tmpdir(), "muha-bridge-prerequisite-"));
    const bin = join(root, "bin"), bridge = join(root, "bridge"), entry = join(bridge, "dist/index.js"), executed = join(root, "executed");
    await mkdir(bin); await mkdir(join(bridge, "dist"), { recursive: true });
    await writeFile(join(bridge, "package.json"), JSON.stringify({ name: "@agentclientprotocol/codex-acp", version, type: "module", bin: { "codex-acp": "dist/index.js" } }));
    await writeFile(entry, '#!/usr/bin/env node\nimport {writeFileSync} from "node:fs"; writeFileSync(process.env.MUHA_BRIDGE_EXECUTED, "executed");\n');
    await chmod(entry, 0o755); await symlink(entry, join(bin, "codex-acp"));
    const base = readOfficialHarnessRegistration(codexAdapter());
    const registration = createOfficialHarnessRegistration("codex", { env: {
      PATH: [bin, resolve(import.meta.dirname, "../fixtures/harness-bin"), dirname(process.execPath)].join(delimiter),
      MUHA_BRIDGE_EXECUTED: executed,
    }, startupTimeoutMs: 500, shutdownTimeoutMs: 500 }, base.capabilities, base.workspaceConfigurator,
    (options, context) => new CodexAcpProcess(options, context));
    let runtime;
    try {
      await assert.rejects(async () => { runtime = await createMuhaRuntime({ harnesses: [registration], dataDir: join(root, "data") }); }, error => error.data?.code === "RUNTIME_INITIALIZATION_FAILED");
      await assert.rejects(access(executed), { code: "ENOENT" });
    } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
  });
}
