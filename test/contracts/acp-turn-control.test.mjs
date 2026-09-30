import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createMuhaRuntime } from "@muha-sdk/core";
import { controlledCodexAdapter, controlledOpenCodeAdapter, acpOptions, collectTurn } from "../fixtures/acp-harness/options.mjs";

test("Runtime initialization failure reclaims a peer ACP endpoint whose handshake is still pending", { timeout: 5000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-acp-init-rollback-"));
  const pidsFile = join(root, "initializing.json");
  const env = { MUHA_FAKE_ACP_INITIALIZING_FILE: pidsFile };
  try {
    await assert.rejects(createMuhaRuntime({
      harnesses: [
        controlledOpenCodeAdapter({ acp: acpOptions("slow-initialize", env) }),
        controlledCodexAdapter({ acp: acpOptions("fail-during-peer-initialize", env) }),
      ], dataDir: join(root, "data"),
    }), error => error.data?.code === "RUNTIME_INITIALIZATION_FAILED");
    const pids = JSON.parse(await readFile(pidsFile, "utf8"));
    for (const pid of pids) await assert.rejects(access(`/proc/${pid}`), { code: "ENOENT" });
  } finally {
    // Rescue only the fixture's recorded owning helper in the red run.
    const pids = await readFile(pidsFile, "utf8").then(JSON.parse, () => []);
    if (pids.length === 2) {
      const command = await readFile(`/proc/${pids[1]}/cmdline`, "utf8").catch(() => "");
      if (command.includes("acp-supervisor") && command.includes("acp-agent.mjs")) {
        process.kill(pids[1], "SIGTERM");
        for (let i = 0; i < 100 && await access(`/proc/${pids[1]}`).then(() => true, () => false); i++) await delay(20);
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("ACP prompt returns an interruptible handle before its terminal response", { timeout: 3000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-acp-prompt-"));
  const runtime = await createMuhaRuntime({ harnesses: [controlledOpenCodeAdapter({ acp: acpOptions("wait-for-cancel") })], dataDir: join(root, "data") });
  try {
    const session = await runtime.createSession({ harness: "opencode", workspacePath: root });
    const pending = session.startTurn([{ type: "text", text: "wait" }]);
    const turn = await Promise.race([pending, delay(500).then(() => undefined)]);
    assert.ok(turn, "startTurn must not await the terminal prompt response");
    await turn.interrupt();
    assert.equal((await collectTurn(turn)).result.status, "interrupted");
    await session.close();
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test("ACP interruption permits an immediate next Turn only after native execution stops", { timeout: 3000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-acp-cancel-continue-"));
  const runtime = await createMuhaRuntime({ harnesses: [controlledOpenCodeAdapter({ acp: acpOptions("delayed-cancel") })], dataDir: join(root, "data") });
  try {
    const session = await runtime.createSession({ harness: "opencode", workspacePath: root });
    const first = await session.startTurn([{ type: "text", text: "wait for interruption" }]);
    await first.interrupt();
    const interrupted = await collectTurn(first);
    assert.equal(interrupted.result.status, "interrupted");
    assert.equal(interrupted.result.reason, "caller");
    assert.deepEqual(interrupted.result.usage, { inputTokens: 10, outputTokens: 3, cachedInputTokens: 1, reasoningTokens: 2 });
    assert.equal(interrupted.events.filter(event => event.type === "turn.interrupted").length, 1);
    const next = await collectTurn(await session.startTurn([{ type: "text", text: "continue immediately" }]));
    assert.equal(next.result.status, "completed");
    assert.equal(next.events.filter(event => event.type === "turn.completed").length, 1);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test("ACP unanswered Session close cannot block Runtime or owned process reclamation", { timeout: 3000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-acp-close-stall-"));
  const options = { ...acpOptions("stall-close"), shutdownTimeoutMs: 150 };
  const runtime = await createMuhaRuntime({ harnesses: [controlledOpenCodeAdapter({ acp: options })], dataDir: join(root, "data") });
  try {
    await runtime.createSession({ harness: "opencode", workspacePath: root });
    const closing = runtime.close();
    const settled = await Promise.race([closing.then(() => true, () => true), delay(650).then(() => false)]);
    assert.equal(settled, true, "shutdown budget must include a missing native close response");
    assert.equal(runtime.status, "closed");
  } finally {
    // The timeout terminates the red case; production must own normal cleanup.
    if (runtime.status === "closed") await rm(root, { recursive: true, force: true });
  }
});

test("ACP allows a normal close acknowledgement within the configured shutdown budget", { timeout: 4000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-acp-close-budget-"));
  const runtime = await createMuhaRuntime({ harnesses: [controlledOpenCodeAdapter({ acp: { ...acpOptions("slow-close"), shutdownTimeoutMs: 2000 } })], dataDir: join(root, "data") });
  try {
    const session = await runtime.createSession({ harness: "opencode", workspacePath: root });
    await session.close();
    assert.equal(runtime.status, "active");
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});
