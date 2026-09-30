import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createMuhaRuntime } from "@muha-sdk/core";
import { controlledOpenCodeAdapter, acpOptions, collectTurn } from "../fixtures/acp-harness/options.mjs";

test("known old ACP message/tool identities cannot publish text or request permission in a later Turn", { timeout: 3000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-acp-ownership-"));
  const runtime = await createMuhaRuntime({ harnesses: [controlledOpenCodeAdapter({ acp: acpOptions("late-old-payload") })], dataDir: join(root, "data") });
  try {
    const session = await runtime.createSession({ harness: "opencode", workspacePath: root, approvalPolicy: "interactive" });
    assert.equal((await collectTurn(await session.startTurn([{ type: "text", text: "A" }]))).result.status, "completed");
    const next = await collectTurn(await session.startTurn([{ type: "text", text: "B" }]));
    assert.equal(next.result.status, "completed");
    assert.equal(next.result.message.text, "echo:B");
    assert.equal(next.events.some(e => e.type === "approval.requested" || e.delta?.includes("LATE_A") || e.message?.text.includes("LATE_A")), false);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});
