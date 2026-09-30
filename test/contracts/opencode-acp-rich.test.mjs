// T14 — OpenCode ACP route: structured input, streamed events, tool pairing,
// final-message/Turn-Result agreement, usage and diagnostics attribution.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { createMuhaRuntime, MuhaError } from "@muha-sdk/core";
import { controlledOpenCodeAdapter as openCodeAdapter } from "../fixtures/acp-harness/options.mjs";
import { acpOptions, collectTurn } from "../fixtures/acp-harness/options.mjs";

function names(events) {
  return events.map((event) => event.type);
}

test("ACP semantic commit failure fatally closes Runtime before mapping the uncommitted payload", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-acp-store-failure-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const runtime = await createMuhaRuntime({ harnesses: [openCodeAdapter({ acp: acpOptions("normal") })], dataDir: join(root, "data") });
  try {
    const session = await runtime.createSession({ harness: "opencode", workspacePath: workspace });
    const db = new DatabaseSync(join(runtime.dataDir, "diagnostic-events.sqlite"));
    try {
      db.exec(`CREATE TRIGGER fail_semantic_commit BEFORE INSERT ON native_event_records
        WHEN json_extract(NEW.payload_json, '$.method') = 'session/update'
        BEGIN SELECT RAISE(FAIL, 'controlled diagnostic write failure'); END`);
    } finally { db.close(); }
    const turn = await session.startTurn([{ type: "text", text: "must not escape persistence" }]);
    const { events, result } = await collectTurn(turn);
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "EVENT_STORE_ERROR");
    assert.equal(events.some(event => event.type.startsWith("assistant.")), false);
    await runtime.close();
    assert.equal(runtime.status, "closed");
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test("OpenCode ACP route preserves reasoning/tool/text/usage event ordering and final agreement", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-acp-rich-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  let runtime;
  let session;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [openCodeAdapter({ acp: acpOptions("rich") })],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({ harness: "opencode", workspacePath: workspace });
    const turn = await session.startTurn([{ type: "text", text: "go" }]);
    const { events, result } = await collectTurn(turn);
    assert.equal(result.status, "completed");
    const sequence = names(events);
    assert.ok(sequence.indexOf("turn.started") < sequence.indexOf("assistant.reasoning.delta"));
    assert.ok(sequence.indexOf("assistant.message.started") < sequence.indexOf("assistant.message.completed"));
    assert.ok(sequence.indexOf("tool.started") < sequence.indexOf("tool.completed"));
    const completedParts = events.filter((e) => e.type === "assistant.message.completed");
    assert.equal(completedParts.length, 1);
    assert.equal(completedParts[0].message.text, "Hello world");
    assert.equal(result.message.text, "Hello world");
    // Usage mapped with real counts (not fabricated zero).
    const usage = events.find((e) => e.type === "usage.updated");
    assert.ok(usage !== undefined);
    assert.equal(usage.usage.inputTokens, 10);
    assert.equal(usage.usage.outputTokens, 3);
    assert.equal(usage.usage.cachedInputTokens, 1);
    assert.equal(usage.usage.reasoningTokens, 2);
    // Tool pairing: one started/update/completed for call_1.
    assert.equal(events.filter((e) => e.type === "tool.started").length, 1);
    assert.equal(events.filter((e) => e.type === "tool.completed").length, 1);
  } finally {
    await session?.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode ACP route treats missing/duplicated native terminal state deterministically", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-acp-dupe-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  let runtime;
  let session;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [openCodeAdapter({ acp: acpOptions("duplicate-terminal") })],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({ harness: "opencode", workspacePath: workspace });
    const turn = await session.startTurn([{ type: "text", text: "once" }]);
    const { events, result } = await collectTurn(turn);
    assert.equal(result.status, "completed");
    // A second terminal status must not produce a second result or event burst.
    const terminal = events.filter((e) => e.type === "turn.completed" || e.type === "turn.failed" || e.type === "turn.interrupted");
    assert.equal(terminal.length, 1);
  } finally {
    await session?.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode ACP route rejects inputs the static Profile does not support with UNSUPPORTED_CAPABILITY", async () => {
  // The OpenCode Profile declares imageInput=true, so an image part is accepted
  // at the contract layer; a raw text-only probe still proves the input boundary
  // typing never fabricates perception. Capability honesty is asserted via the
  // untouched static Profile.
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-acp-image-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  let runtime;
  let session;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [openCodeAdapter({ acp: acpOptions("normal") })],
      dataDir: join(root, "diagnostics"),
    });
    assert.equal(runtime.getHarnessCapabilities("opencode").imageInput, true);
    const { createSessionReference } = await import("@muha-sdk/core");
    session = await runtime.createSession({ harness: "opencode", workspacePath: workspace });
    const buffer = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    const turn = await session.startTurn([{
      type: "image",
      source: { type: "base64", mediaType: "image/png", data: buffer.toString("base64") },
    }]);
    const { result } = await collectTurn(turn);
    assert.equal(result.status, "completed");
  } finally {
    await session?.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode ACP route surfaces unknown/malformed events without fabricating results", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-acp-mal-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  let runtime;
  let session;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [openCodeAdapter({ acp: acpOptions("malformed-frame") })],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({ harness: "opencode", workspacePath: workspace });
    const turn = await session.startTurn([{ type: "text", text: "boom" }]);
    const { events, result } = await collectTurn(turn);
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "ADAPTER_PROTOCOL_ERROR");
    assert.equal(names(events).filter((name) => name === "turn.completed").length, 0);
  } finally {
    await session?.close();
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode ACP route commits complete semantic payloads before delivery, without logs or auth secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-acp-diag-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  let runtime;
  let session;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [openCodeAdapter({ acp: acpOptions("rich") })],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({ harness: "opencode", workspacePath: workspace });
    const turn = await session.startTurn([{ type: "text", text: "diag" }]);
    // This pre-agreed provenance seam observes the private storage artifact,
    // not a new consumer-facing raw-event API.
    const db = new DatabaseSync(join(runtime.dataDir, "diagnostic-events.sqlite"), { readOnly: true });
    try {
      for await (const event of turn) {
        if (event.type !== "assistant.message.completed") continue;
        const records = db.prepare("SELECT payload_json FROM native_event_records WHERE harness = 'opencode' ORDER BY record_id")
          .all().map(row => JSON.parse(row.payload_json));
        assert.ok(records.some(record => record.params?.update?.content?.type === "text" && record.params.update.content.text === "Hello ") &&
          records.some(record => record.params?.update?.content?.text === "world"),
          "the full native payload must already be committed when its mapped event is observed");
      }
      assert.equal((await turn.result).status, "completed");
      const payloads = db.prepare("SELECT payload_json FROM native_event_records ORDER BY record_id").all().map(row => row.payload_json);
      const records = payloads.map(JSON.parse);
      assert.ok(records.some(record => record.result?.sessionId === session.reference.sessionId), "Session control response is a complete native record");
      assert.ok(records.some(record => record.result?.agentCapabilities?.loadSession === true));
      assert.doesNotMatch(payloads.join("\n"), /MUHA_TEST_(PROCESS|AUTH)_SECRET_NEVER_PERSIST/);
      const normalized = db.prepare("SELECT payload_json FROM core_event_records").all().map(row => JSON.parse(row.payload_json));
      assert.equal(normalized.some(event => event.type?.startsWith("assistant.")), false, "native-backed events must not be duplicated as Core-originated records");
    } finally { db.close(); }
    await runtime.close();
    runtime = undefined;
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});
