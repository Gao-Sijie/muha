import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { delimiter, dirname } from "node:path";

const script = new URL("../../scripts/qualify-performance-capabilities.mjs", import.meta.url).pathname;

test("Kimi qualification trusts only its owned fixture and revokes native trust before stopping", async () => {
  const { trustKimiQualificationWorkspace } = await import("../../scripts/kimi-qualification-trust.mjs");
  const { mkdir } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "muha-pf-kimi-"));
  const workspace = join(root, "workspace");
  const evidence = join(root, "native-admin.json");
  await mkdir(workspace);
  try {
    await assert.rejects(trustKimiQualificationWorkspace(root, root), /owned qualification workspace/);
    const close = await trustKimiQualificationWorkspace(root, workspace, {
      env: { ...process.env, PATH: [new URL("../fixtures/harness-bin", import.meta.url).pathname,
        dirname(process.execPath)].join(delimiter), MUHA_FAKE_KIMI_EVIDENCE_FILE: evidence },
    });
    await close();
    await close();
    const native = JSON.parse(await readFile(evidence, "utf8"));
    assert.equal(native.prompts.length, 0);
    assert.equal(native.unauthorizedRequests, 0);
    assert.deepEqual(native.requests.map(({ method, path }) => [method, path]), [
      ["POST", "/api/v1/workspaces"], ["GET", "/api/v1/workspaces/ws_fake_1/trust"],
      ["POST", "/api/v1/workspaces/ws_fake_1/trust"], ["GET", "/api/v1/workspaces/ws_fake_1/trust"],
      ["POST", "/api/v1/workspaces/ws_fake_1/untrust"], ["GET", "/api/v1/workspaces/ws_fake_1/trust"],
      ["DELETE", "/api/v1/workspaces/ws_fake_1"],
    ]);
  } finally { await rm(root, { recursive: true }); }
});

test("capability qualification rejects implicit all and model substitution before native startup", () => {
  const implicit = spawnSync(process.execPath, [script, "all", "--approval"], { encoding: "utf8" });
  assert.equal(implicit.status, 2);
  assert.match(implicit.stderr, /explicit Harness/);
  const substituted = spawnSync(process.execPath, [script, "pi", "--skills"], {
    encoding: "utf8", env: { ...process.env, MUHA_QUALIFY_PI_MODEL: "opencode-go/qwen3.8-flash" },
  });
  assert.equal(substituted.status, 2);
  assert.match(substituted.stderr, /must equal opencode-go\/deepseek-v4.1-flash/);
});

test("approval evidence distinguishes a native deny without a public request from caller denial", async () => {
  const { assertApprovalEvidence } = await import("../../scripts/qualify-performance-capabilities.mjs");
  const terminal = { type: "turn.completed" };
  const nativeDenied = { result: { status: "completed" }, events: [
    { type: "tool.started" }, { type: "tool.completed", isError: true }, terminal,
  ] };
  assert.doesNotThrow(() => assertApprovalEvidence(nativeDenied, { policy: "autoDeny", allowed: false }));
  assert.throws(() => assertApprovalEvidence(nativeDenied, { policy: "interactive", allowed: false }));
  assert.throws(() => assertApprovalEvidence({ result: { status: "completed" }, events: [terminal] },
    { policy: "autoDeny", allowed: false }));
  assert.throws(() => assertApprovalEvidence({ result: { status: "completed" }, events: [
    { type: "tool.started" }, { type: "tool.completed", isError: false }, terminal,
  ] }, { policy: "autoDeny", allowed: false }));
});

test("OpenCode tool suppression needs a recorded native deny-all rule, not just model refusal", async () => {
  const { assertApprovalEvidence } = await import("../../scripts/qualify-performance-capabilities.mjs");
  const execution = { result: { status: "completed" }, events: [{ type: "turn.completed" }] };
  assert.doesNotThrow(() => assertApprovalEvidence(execution, { policy: "autoDeny", allowed: false,
    harness: "opencode", nativePermissions: [{ action: "*", resource: "*", effect: "deny" }] }));
  assert.throws(() => assertApprovalEvidence(execution, { policy: "autoDeny", allowed: false,
    harness: "opencode", nativePermissions: [{ action: "*", resource: "*", effect: "ask" }] }));
  assert.throws(() => assertApprovalEvidence(execution, { policy: "autoDeny", allowed: false,
    harness: "codex", nativePermissions: [{ action: "*", resource: "*", effect: "deny" }] }));
});

test("real MCP evidence requires a successful public Tool result matching the server receipt, not a model echo", async () => {
  const { assertMcpEvidence } = await import("../../scripts/qualify-performance-capabilities.mjs");
  const execution = { result: { status: "completed", message: { text: "" } }, events: [
    { type: "tool.started", toolCallId: "call", toolName: "muha-pf-proof.proof" },
    { type: "tool.completed", toolCallId: "call", isError: false,
      output: { content: [{ type: "text", text: "SERVER_PROOF" }] } },
    { type: "turn.completed" },
  ] };
  assert.doesNotThrow(() => assertMcpEvidence(execution, [{ tool: "proof", proof: "SERVER_PROOF" }]));
  assert.throws(() => assertMcpEvidence(execution, []));
  assert.throws(() => assertMcpEvidence(execution, [{ tool: "proof", proof: "NOT_RETURNED" }]));
  assert.throws(() => assertMcpEvidence({ ...execution, events: [execution.events[0],
    { ...execution.events[1], isError: true }, execution.events[2]] }, [{ tool: "proof", proof: "SERVER_PROOF" }]));
});

test("qualification MCP fixture negotiates tools and generates a receipt only for an actual proof call", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-proof-mcp-test-"));
  const receipt = join(root, "receipt.jsonl");
  try {
    const fixture = new URL("../../scripts/fixtures/performance-proof-mcp.mjs", import.meta.url).pathname;
    const child = spawnSync(process.execPath, [fixture, receipt], { encoding: "utf8", input: [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "proof", arguments: {} } },
    ].map(JSON.stringify).join("\n") + "\n" });
    assert.equal(child.status, 0, child.stderr);
    const messages = child.stdout.trim().split("\n").map(JSON.parse);
    assert.deepEqual(messages.map(message => message.id), [1, 2, 3]);
    assert.equal(messages[0].result.protocolVersion, "2024-11-05");
    assert.equal(messages[1].result.tools[0].name, "proof");
    const rows = (await readFile(receipt, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].proof, messages[2].result.content[0].text);
    assert.match(rows[0].proof, /^MUHA_MCP_[a-f0-9]{32}$/);
  } finally { await rm(root, { recursive: true }); }
});
