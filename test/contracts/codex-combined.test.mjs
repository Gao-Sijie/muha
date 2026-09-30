import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createMuhaRuntime } from "@muha-sdk/core";
import { codexAdapter } from "@muha-sdk/codex-adapter";
import { createOfficialHarnessRegistration, readOfficialHarnessRegistration } from "../../packages/core/dist/internal.js";

test("Codex combined preserves native web search input and results", { timeout: 10000 }, async () => {
  const { CodexAcpProcess } = await import("../../packages/codex-adapter/dist/codex-acp.js");
  const root = await mkdtemp(join(tmpdir(), "muha-codex-search-"));
  const base = readOfficialHarnessRegistration(codexAdapter());
  const registration = createOfficialHarnessRegistration("codex", { env: {
    PATH: [resolve(import.meta.dirname, "../fixtures/harness-bin"), dirname(process.execPath)].join(delimiter),
    MUHA_FAKE_TURN_SCENARIO: "rich", MUHA_FAKE_EXTRA_TOOL: "webSearch",
  }, shutdownTimeoutMs: 1000 }, base.capabilities, base.workspaceConfigurator,
  (options, context) => new CodexAcpProcess(options, context, { command: process.execPath, prefix: [resolve(import.meta.dirname, "../fixtures/acp-harness/codex-combined.mjs")] }));
  const runtime = await createMuhaRuntime({ harnesses: [registration], dataDir: join(root, "data") });
  try {
    const session = await runtime.createSession({ harness: "codex", workspacePath: root });
    const turn = await session.startTurn([{ type: "text", text: "search" }]);
    const events = [];
    for await (const event of turn) events.push(event);
    assert.equal((await turn.result).status, "completed", JSON.stringify(await turn.result));
    const started = events.find(event => event.type === "tool.started" && event.toolName === "webSearch");
    assert.deepEqual(started?.input, { query: "muha", action: { type: "search", query: "muha", queries: ["muha"] } });
    const completed = events.find(event => event.type === "tool.completed" && event.toolCallId === started.toolCallId);
    assert.deepEqual(completed?.output, { query: "muha", action: { type: "search", query: "muha", queries: ["muha"] }, results: [{ title: "Result", url: "https://example.test/muha" }] });
    assert.equal(completed?.isError, false);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test("Codex combined image-view terminal is backed by its delayed native completion", { timeout: 10000 }, async () => {
  const { CodexAcpProcess } = await import("../../packages/codex-adapter/dist/codex-acp.js");
  const root = await mkdtemp(join(tmpdir(), "muha-codex-image-view-"));
  const base = readOfficialHarnessRegistration(codexAdapter());
  const registration = createOfficialHarnessRegistration("codex", { env: {
    PATH: [resolve(import.meta.dirname, "../fixtures/harness-bin"), dirname(process.execPath)].join(delimiter),
    MUHA_FAKE_TURN_SCENARIO: "rich", MUHA_FAKE_EXTRA_TOOL: "imageView",
  }, shutdownTimeoutMs: 1000 }, base.capabilities, base.workspaceConfigurator,
  (options, context) => new CodexAcpProcess(options, context, { command: process.execPath, prefix: [resolve(import.meta.dirname, "../fixtures/acp-harness/codex-combined.mjs")] }));
  const runtime = await createMuhaRuntime({ harnesses: [registration], dataDir: join(root, "data") });
  const db = new DatabaseSync(join(runtime.dataDir, "diagnostic-events.sqlite"), { readOnly: true });
  try {
    const session = await runtime.createSession({ harness: "codex", workspacePath: root });
    const turn = await session.startTurn([{ type: "text", text: "view image" }]);
    let imageToolId;
    for await (const event of turn) {
      if (event.type === "tool.started" && event.toolName === "imageView") {
        imageToolId = event.toolCallId;
        assert.deepEqual(event.input, { path: "/native/picture.png" });
      }
      if (event.type === "tool.completed" && event.toolCallId === imageToolId) {
        const terminal = db.prepare("SELECT count(*) AS n FROM native_event_records WHERE json_extract(payload_json, '$.method') = 'item/completed' AND json_extract(payload_json, '$.params.item.type') = 'imageView'").get();
        assert.equal(terminal.n, 1, "native completion must commit before public completion");
        assert.deepEqual(event.output, { path: "/native/picture.png" });
      }
    }
    assert.equal((await turn.result).status, "completed", JSON.stringify(await turn.result));
    assert.ok(imageToolId);
  } finally { db.close(); await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test("Codex combined preserves image-generation, compaction and subagent native items", { timeout: 10000 }, async () => {
  const { CodexAcpProcess } = await import("../../packages/codex-adapter/dist/codex-acp.js");
  const root = await mkdtemp(join(tmpdir(), "muha-codex-native-tools-"));
  const base = readOfficialHarnessRegistration(codexAdapter());
  const compaction = { type: "contextCompaction", id: "compact" };
  const activity = { type: "subAgentActivity", id: "activity", agentThreadId: "child", agentPath: "/root/child", kind: "started" };
  const collaboration = { type: "collabAgentToolCall", id: "spawn", tool: "spawnAgent", senderThreadId: "parent", receiverThreadIds: ["child"], prompt: "Inspect only", model: "gpt-5.6-luna", reasoningEffort: "low", status: "inProgress", agentsStates: {} };
  const registration = createOfficialHarnessRegistration("codex", { env: {
    PATH: [resolve(import.meta.dirname, "../fixtures/harness-bin"), dirname(process.execPath)].join(delimiter),
    MUHA_FAKE_TURN_SCENARIO: "rich", MUHA_FAKE_EXTRA_NATIVE_ITEMS: JSON.stringify([
      { started: { type: "imageGeneration", id: "image", status: "inProgress", result: "" }, completed: { type: "imageGeneration", id: "image", status: "failed", result: "", failure: { type: "usageLimitExceeded", limitId: "image", resetsAt: null } } },
      { started: compaction, completed: compaction }, { started: collaboration, completed: { ...collaboration, status: "completed", agentsStates: { child: { status: "completed", message: "done" } } } },
      { started: activity, completed: activity },
    ]),
  }, shutdownTimeoutMs: 1000 }, base.capabilities, base.workspaceConfigurator,
  (options, context) => new CodexAcpProcess(options, context, { command: process.execPath, prefix: [resolve(import.meta.dirname, "../fixtures/acp-harness/codex-combined.mjs")] }));
  const runtime = await createMuhaRuntime({ harnesses: [registration], dataDir: join(root, "data") });
  try {
    const session = await runtime.createSession({ harness: "codex", workspacePath: root });
    const turn = await session.startTurn([{ type: "text", text: "native tools" }]);
    const events = [];
    for await (const event of turn) events.push(event);
    assert.equal((await turn.result).status, "completed", JSON.stringify(await turn.result));
    const starts = events.filter(event => event.type === "tool.started").slice(0, 4);
    assert.deepEqual(starts.map(({ toolName, input }) => ({ toolName, input })), [
      { toolName: "imageGeneration", input: {} }, { toolName: "contextCompaction", input: {} },
      { toolName: "spawnAgent", input: { senderThreadId: "parent", receiverThreadIds: ["child"], prompt: "Inspect only", model: "gpt-5.6-luna", reasoningEffort: "low" } },
      { toolName: "subAgentActivity", input: { agentThreadId: "child", agentPath: "/root/child", kind: "started" } },
    ]);
    const ends = starts.map(start => events.find(event => event.type === "tool.completed" && event.toolCallId === start.toolCallId));
    assert.deepEqual(ends.map(({ output, isError }) => ({ output, isError })), [
      { output: { status: "failed", result: "", failure: { type: "usageLimitExceeded", limitId: "image", resetsAt: null } }, isError: true },
      { output: {}, isError: false },
      { output: { status: "completed", agentsStates: { child: { status: "completed", message: "done" } } }, isError: false },
      { output: { agentThreadId: "child", agentPath: "/root/child", kind: "started" }, isError: false },
    ]);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

test("idle handles for one ACP Session retain their own model and approval policy when alternating Turns", { timeout: 6000 }, async () => {
  const { CodexAcpProcess } = await import("../../packages/codex-adapter/dist/codex-acp.js");
  const root = await mkdtemp(join(tmpdir(), "muha-acp-handle-policy-"));
  const received = join(root, "native-request.json");
  const base = readOfficialHarnessRegistration(codexAdapter());
  const registration = createOfficialHarnessRegistration("codex", { env: {
    PATH: [resolve(import.meta.dirname, "../fixtures/harness-bin"), dirname(process.execPath)].join(delimiter),
    MUHA_FAKE_TURN_REQUEST_FILE: received,
  }, shutdownTimeoutMs: 500 }, base.capabilities, base.workspaceConfigurator,
  (options, context) => new CodexAcpProcess(options, context, { command: process.execPath, prefix: [resolve(import.meta.dirname, "../fixtures/acp-harness/codex-combined.mjs")] }));
  const runtime = await createMuhaRuntime({ harnesses: [registration], dataDir: join(root, "data") });
  try {
    const autonomous = await runtime.createSession({ harness: "codex", workspacePath: root, model: "fixture-a", approvalPolicy: "autoApprove" });
    const restricted = await runtime.resumeSession({ reference: autonomous.reference, model: "fixture-b", approvalPolicy: "autoDeny" });
    assert.equal(autonomous.model, "fixture-a");
    assert.equal(restricted.model, "fixture-b");
    for (const handle of [autonomous, restricted, autonomous, restricted]) {
      const turn = await handle.startTurn([{ type: "text", text: "use this handle's run selections" }]);
      for await (const _ of turn) {}
      assert.equal((await turn.result).status, "completed", JSON.stringify(await turn.result));
      const request = JSON.parse(await readFile(received, "utf8"));
      assert.equal(request.model, handle === autonomous ? "fixture-a" : "fixture-b");
      assert.equal(request.approvalPolicy, handle === autonomous ? "never" : "on-request");
      assert.equal(request.sandboxPolicy.type, handle === autonomous ? "dangerFullAccess" : "workspaceWrite");
    }
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

for (const lagging of [false, true]) {
test(`Codex combined route maps committed native tools and usage (lagging ACP = ${lagging})`, { timeout: 10000 }, async () => {
  const { CodexAcpProcess } = await import("../../packages/codex-adapter/dist/codex-acp.js");
  const root = await mkdtemp(join(tmpdir(), "muha-codex-combined-"));
  const base = readOfficialHarnessRegistration(codexAdapter());
  const registration = createOfficialHarnessRegistration("codex", { env: {
    PATH: [resolve(import.meta.dirname, "../fixtures/harness-bin"), dirname(process.execPath)].join(delimiter),
    MUHA_FAKE_TURN_SCENARIO: "rich", MUHA_FAKE_NATIVE_SESSIONS_FILE: join(root, "native-sessions.json"),
    ...(lagging ? { MUHA_FAKE_COMPLETED_TOOL_INPUT: "1" } : {}),
  }, startupTimeoutMs: 2000, shutdownTimeoutMs: 1000 }, base.capabilities, base.workspaceConfigurator,
  (options, context) => new CodexAcpProcess(options, context, { command: process.execPath, prefix: [resolve(import.meta.dirname, "../fixtures/acp-harness/codex-combined.mjs")] }));
  const runtime = await createMuhaRuntime({ harnesses: [registration], dataDir: join(root, "data") });
  try {
    const session = await runtime.createSession({ harness: "codex", workspacePath: root });
    assert.equal(session.reference.route, "combined");
    const turn = await session.startTurn([{ type: "text", text: "rich" }]);
    const events = [];
    const db = new DatabaseSync(join(runtime.dataDir, "diagnostic-events.sqlite"), { readOnly: true });
    try {
      for await (const event of turn) {
        events.push(event);
        if (event.type === "tool.started") {
          const native = db.prepare("SELECT payload_json FROM native_event_records WHERE harness = 'codex' ORDER BY record_id").all().map(row => JSON.parse(row.payload_json));
          assert.ok(native.some(record => record.method === "item/started" && record.params?.item?.type === (event.toolName === "commandExecution" ? "commandExecution" : "mcpToolCall")), "complete native Tool must commit before its public event");
        }
      }
      const records = db.prepare("SELECT payload_json FROM native_event_records WHERE harness = 'codex'").all();
      assert.doesNotMatch(records.map(row => row.payload_json).join("\n"), /MUHA_INTERNAL_CODEX_TOKEN|"type":"hello"/);
    } finally { db.close(); }
    const result = await turn.result;
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(result.message.text, "Final.");
    const tools = events.filter(event => event.type === "tool.started");
    assert.deepEqual(tools.map(tool => tool.toolName), ["commandExecution", "demo.lookup"]);
    assert.deepEqual(tools[0].input, { command: "printf hi", cwd: root });
    assert.deepEqual(events.find(event => event.type === "tool.completed").output,
      { aggregatedOutput: "hi", exitCode: 0, durationMs: 3, status: "completed" });
    assert.deepEqual(result.usage, { inputTokens: 9, outputTokens: 4, cachedInputTokens: 3, reasoningTokens: 1 });
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});
}

test("Codex native observation cannot bypass a failed semantic commit", { timeout: 5000 }, async () => {
  const { CodexAcpProcess } = await import("../../packages/codex-adapter/dist/codex-acp.js");
  const root = await mkdtemp(join(tmpdir(), "muha-codex-observer-store-"));
  const base = readOfficialHarnessRegistration(codexAdapter());
  const registration = createOfficialHarnessRegistration("codex", { env: {
    PATH: [resolve(import.meta.dirname, "../fixtures/harness-bin"), dirname(process.execPath)].join(delimiter),
    MUHA_FAKE_TURN_SCENARIO: "rich",
  }, startupTimeoutMs: 2000, shutdownTimeoutMs: 500 }, base.capabilities, base.workspaceConfigurator,
  (options, context) => new CodexAcpProcess(options, context, { command: process.execPath, prefix: [resolve(import.meta.dirname, "../fixtures/acp-harness/codex-combined.mjs")] }));
  const runtime = await createMuhaRuntime({ harnesses: [registration], dataDir: join(root, "data") });
  try {
    const session = await runtime.createSession({ harness: "codex", workspacePath: root });
    const db = new DatabaseSync(join(runtime.dataDir, "diagnostic-events.sqlite"));
    try {
      db.exec(`CREATE TRIGGER fail_native_observation BEFORE INSERT ON native_event_records
        WHEN json_extract(NEW.payload_json, '$.method') = 'item/started'
        BEGIN SELECT RAISE(FAIL, 'injected native observation failure'); END;`);
    } finally { db.close(); }
    const turn = await session.startTurn([{ type: "text", text: "fail storage" }]);
    const events = [];
    for await (const event of turn) events.push(event);
    const result = await turn.result;
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "EVENT_STORE_ERROR");
    assert.equal(events.some(event => event.type === "tool.started"), false);
  } finally { await runtime.close().catch(() => {}); await rm(root, { recursive: true, force: true }); }
});

test("Codex combined Adapter resumes an explicit native Reference on its original execution path", { timeout: 5000 }, async () => {
  const { CodexAcpProcess } = await import("../../packages/codex-adapter/dist/codex-acp.js");
  const root = await mkdtemp(join(tmpdir(), "muha-codex-native-route-"));
  const options = { env: {
    PATH: [resolve(import.meta.dirname, "../fixtures/harness-bin"), dirname(process.execPath)].join(delimiter),
    MUHA_FAKE_NATIVE_SESSIONS_FILE: join(root, "native-sessions.json"),
  } };
  let runtime = await createMuhaRuntime({ harnesses: [codexAdapter(options)], dataDir: join(root, "data") });
  try {
    const original = await runtime.createSession({ harness: "codex", workspacePath: root });
    const reference = JSON.parse(JSON.stringify(original.reference));
    const first = await original.startTurn([{ type: "text", text: "native history" }]);
    for await (const _ of first) {}
    assert.equal((await first.result).status, "completed");
    await runtime.close();
    const base = readOfficialHarnessRegistration(codexAdapter());
    const registration = createOfficialHarnessRegistration("codex", options, base.capabilities, base.workspaceConfigurator,
      (snapshot, context) => new CodexAcpProcess(snapshot, context, { command: process.execPath, prefix: [resolve(import.meta.dirname, "../fixtures/acp-harness/codex-combined.mjs")] }));
    runtime = await createMuhaRuntime({ harnesses: [registration], dataDir: join(root, "data") });
    const resumed = await runtime.resumeSession({ reference, approvalPolicy: "autoApprove" });
    assert.deepEqual(resumed.reference, reference);
    const next = await resumed.startTurn([{ type: "text", text: "still native" }]);
    for await (const _ of next) {}
    assert.equal((await next.result).status, "completed");
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

for (const drift of ["model", "effort", "policy", "identity"]) {
  test(`Codex refuses bridge ${drift} drift before the sole native executor receives a Turn`, { timeout: 5000 }, async () => {
    const { CodexAcpProcess } = await import("../../packages/codex-adapter/dist/codex-acp.js");
    const root = await mkdtemp(join(tmpdir(), "muha-codex-bridge-drift-"));
    const received = join(root, "native-turn-received");
    const base = readOfficialHarnessRegistration(codexAdapter());
    const registration = createOfficialHarnessRegistration("codex", { env: {
      PATH: [resolve(import.meta.dirname, "../fixtures/harness-bin"), dirname(process.execPath)].join(delimiter),
      MUHA_FAKE_TURN_REQUEST_COUNT_FILE: received, MUHA_FAKE_CODEX_COMBINED_DRIFT: drift,
    }, shutdownTimeoutMs: 500 }, base.capabilities, base.workspaceConfigurator,
    (options, context) => new CodexAcpProcess(options, context, { command: process.execPath, prefix: [resolve(import.meta.dirname, "../fixtures/acp-harness/codex-combined.mjs")] }));
    const runtime = await createMuhaRuntime({ harnesses: [registration], dataDir: join(root, "data") });
    try {
      const session = await runtime.createSession({ harness: "codex", workspacePath: root, effort: "medium" });
      const turn = await session.startTurn([{ type: "text", text: "must not execute" }]);
      let deadline;
      const drained = (async () => { for await (const _ of turn) {} })();
      try {
        await Promise.race([drained, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("bridge drift was not rejected")), 1200); })]);
      } finally { clearTimeout(deadline); }
      assert.equal((await turn.result).status, "failed");
      await assert.rejects(access(received), { code: "ENOENT" });
    } finally { await runtime.close().catch(() => {}); await rm(root, { recursive: true, force: true }); }
  });
}
