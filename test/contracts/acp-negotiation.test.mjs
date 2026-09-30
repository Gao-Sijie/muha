import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMuhaRuntime } from "@muha-sdk/core";
import { controlledOpenCodeAdapter, acpOptions } from "../fixtures/acp-harness/options.mjs";

test("ACP negotiates the actual integer-v1 initialization contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-acp-negotiation-"));
  const evidenceFile = join(root, "evidence.json");
  let runtime;
  try {
    runtime = await createMuhaRuntime({ harnesses: [controlledOpenCodeAdapter({ acp: acpOptions("normal", {
      MUHA_FAKE_ACP_EVIDENCE_FILE: evidenceFile,
    }) })], dataDir: root });
    assert.equal(runtime.getHarnessCapabilities("opencode").imageInput, true);
    const coreManifest = JSON.parse(await readFile(join(import.meta.dirname, "../../packages/core/package.json"), "utf8"));
    const evidence = JSON.parse(await readFile(evidenceFile, "utf8"));
    const initialize = evidence.requests.find(request => request.method === "initialize");
    assert.deepEqual(initialize?.params.clientInfo, { name: "muha-sdk", version: coreManifest.version });
  } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
});

for (const scenario of ["empty-initialize", "wrong-version", "unknown-initialize-field", "missing-load", "missing-image", "missing-list", "missing-close"]) {
  test(`ACP refuses incomplete negotiation (${scenario}) without shrinking its Profile`, async () => {
    const root = await mkdtemp(join(tmpdir(), "muha-acp-negotiation-"));
    let runtime;
    try {
      await assert.rejects(async () => {
        runtime = await createMuhaRuntime({ harnesses: [controlledOpenCodeAdapter({ acp: acpOptions(scenario) })], dataDir: root });
      }, error => error.data?.code === "RUNTIME_INITIALIZATION_FAILED");
    } finally { await runtime?.close(); await rm(root, { recursive: true, force: true }); }
  });
}

test("ACP rejects a Session without model configuration and closes its incomplete native handle", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-acp-session-negotiation-"));
  const evidence = join(root, "evidence.json");
  const runtime = await createMuhaRuntime({ harnesses: [controlledOpenCodeAdapter({ acp: acpOptions("missing-model-config", { MUHA_FAKE_ACP_EVIDENCE_FILE: evidence }) })], dataDir: join(root, "data") });
  try {
    await assert.rejects(runtime.createSession({ harness: "opencode", workspacePath: root }), error => error.data?.code === "ADAPTER_PROTOCOL_ERROR");
    const recorded = JSON.parse(await readFile(evidence, "utf8"));
    assert.deepEqual(recorded.closedSessions, ["acp_ses_1"]);
    assert.equal(recorded.prompts.length, 0);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test("an ACP selection with contradictory acknowledgement closes the Session without publishing a guessed value", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-acp-config-ack-"));
  const runtime = await createMuhaRuntime({ harnesses: [controlledOpenCodeAdapter({ acp: acpOptions("model-ack-drift") })], dataDir: join(root, "data") });
  try {
    const session = await runtime.createSession({ harness: "opencode", workspacePath: root });
    await assert.rejects(session.setModel("gpt-5.6-luna"), error => error.data?.code === "ADAPTER_PROTOCOL_ERROR");
    assert.equal(session.status.status, "closed");
    await assert.rejects(session.startTurn([{ type: "text", text: "do not submit" }]));
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test("an unsolicited ACP model update cannot silently change execution selections", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-acp-config-drift-"));
  const runtime = await createMuhaRuntime({ harnesses: [controlledOpenCodeAdapter({ acp: acpOptions("unsolicited-model-drift") })], dataDir: join(root, "data") });
  try {
    const session = await runtime.createSession({ harness: "opencode", workspacePath: root, model: "gpt-5.6-luna" });
    const turn = await session.startTurn([{ type: "text", text: "must preserve selected model" }]);
    for await (const _ of turn) {}
    const result = await turn.result;
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "ADAPTER_PROTOCOL_ERROR");
    await assert.rejects(session.startTurn([{ type: "text", text: "must not reuse drifted configuration" }]));
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});
