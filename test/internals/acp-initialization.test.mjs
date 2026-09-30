import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { OpenCodeAcpProcess } from "../../packages/opencode-adapter/dist/opencode-acp.js";

test("closing a combined Driver during port reservation prevents later endpoint startup", { timeout: 5000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-acp-reservation-close-"));
  const pidsFile = join(root, "initializing.json");
  const adapter = new OpenCodeAcpProcess({
    startupTimeoutMs: 1000, shutdownTimeoutMs: 500,
    env: { MUHA_FAKE_ACP_SCENARIO: "slow-initialize", MUHA_FAKE_ACP_INITIALIZING_FILE: pidsFile },
  }, { async recordNativeEvent() {}, reportFatalError() {} }, {
    command: process.execPath, prefix: [new URL("../fixtures/acp-harness/acp-agent.mjs", import.meta.url).pathname],
  });
  const pending = adapter.initialize();
  const outcome = pending.then(() => ({ initialized: true }), error => ({ error }));
  try {
    await adapter.close();
    assert.ok((await outcome).error, "closed initialization must reject");
    await assert.rejects(access(pidsFile), { code: "ENOENT" });
  } finally {
    const pids = await readFile(pidsFile, "utf8").then(JSON.parse, () => []);
    if (pids.length === 2) {
      const command = await readFile(`/proc/${pids[1]}/cmdline`, "utf8").catch(() => "");
      if (command.includes("acp-supervisor") && command.includes("acp-agent.mjs")) {
        process.kill(pids[1], "SIGTERM");
        for (let i = 0; i < 100 && await access(`/proc/${pids[1]}`).then(() => true, () => false); i++) await delay(20);
      }
    }
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});
