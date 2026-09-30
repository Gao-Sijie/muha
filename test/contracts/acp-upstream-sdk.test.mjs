import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createMuhaRuntime } from "@muha-sdk/core";
import { controlledOpenCodeAdapter, acpOptions, collectTurn } from "../fixtures/acp-harness/options.mjs";

test("shared Driver interoperates with upstream ACP SDK validation, pagination, replay and cancellation", { timeout: 5000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-acp-upstream-"));
  const runtime = await createMuhaRuntime({ harnesses: [controlledOpenCodeAdapter({ acp: acpOptions("sdk-canonical") })], dataDir: join(root, "data") });
  try {
    const first = await runtime.createSession({ harness: "opencode", workspacePath: root, model: "fixture-model", effort: "high", approvalPolicy: "interactive" });
    const second = await runtime.createSession({ harness: "opencode", workspacePath: root });
    assert.equal(first.effort, "high");
    assert.equal((await runtime.listSessions({ harness: "opencode", workspacePath: root })).length, 2);
    const turn = await first.startTurn([{ type: "text", text: "permission" }]);
    const events = [];
    for await (const event of turn) {
      events.push(event);
      if (event.type === "approval.requested") await turn.respondToApproval(event.requestId, "allowOnce");
    }
    assert.equal((await turn.result).status, "completed");
    assert.equal(events.filter(e => e.type === "tool.started").length, 1);
    assert.equal(events.filter(e => e.type === "tool.completed").length, 1);
    const reference = first.reference;
    await first.close();
    const resumed = await runtime.resumeSession({ reference });
    const fresh = await collectTurn(await resumed.startTurn([{ type: "text", text: "fresh" }]));
    assert.equal(fresh.result.message.text, "sdk:fresh");
    assert.equal(fresh.events.some(e => e.message?.text === "old history"), false);
    const waiting = await second.startTurn([{ type: "text", text: "wait" }]);
    await waiting.interrupt();
    assert.equal((await collectTurn(waiting)).result.status, "interrupted");
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});
