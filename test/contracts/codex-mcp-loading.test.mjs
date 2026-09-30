import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

import { codexAdapter } from "@muha-sdk/codex-adapter";
import { createMuhaRuntime } from "@muha-sdk/core";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const probeServer = resolve(import.meta.dirname, "../fixtures/mcp-bin/loading-probe.mjs");

test(
  "a fresh real Codex Runtime loads and lists project MCP configured by an earlier Runtime",
  { skip: process.env.MUHA_REAL_CODEX_MCP_SMOKE !== "1" },
  async () => {
    const root = await mkdtemp(join(repositoryRoot, ".muha-real-codex-mcp-"));
    const workspace = join(root, "workspace");
    const dataDir = join(root, "diagnostics");
    const markerPath = join(root, "mcp-loaded");
    let configurationRuntime;
    let executionRuntime;
    let session;

    await mkdir(workspace);
    try {
      configurationRuntime = await createMuhaRuntime({
        harnesses: [codexAdapter()],
        dataDir,
      });
      const configured = await configurationRuntime.configureWorkspace({
        workspacePath: workspace,
        harnesses: ["codex"],
        mcpServers: [{
          name: "muha-loading-probe",
          transport: "stdio",
          command: process.execPath,
          args: [probeServer],
          env: { MUHA_MCP_LOADING_MARKER: markerPath },
        }],
      });
      assert.deepEqual(configured.attempts, [{
        kind: "mcp",
        harness: "codex",
        inputIndex: 0,
        status: "succeeded",
      }]);

      await configurationRuntime.close();
      configurationRuntime = undefined;

      executionRuntime = await createMuhaRuntime({
        harnesses: [codexAdapter()],
        dataDir,
      });
      session = await executionRuntime.createSession({
        harness: "codex",
        workspacePath: workspace,
      });

      await waitForFile(markerPath, 10_000);
    } finally {
      await session?.close();
      await executionRuntime?.close();
      await configurationRuntime?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

async function waitForFile(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await access(path);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (Date.now() >= deadline) {
      throw new Error(`real Codex did not load and list the configured MCP server within ${timeoutMs}ms`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}
