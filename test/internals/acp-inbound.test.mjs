import assert from "node:assert/strict";
import test from "node:test";
import { AcpConnection } from "../../packages/core/dist/acp/connection.js";
import { acpOptions } from "../fixtures/acp-harness/options.mjs";
import { setTimeout as delay } from "node:timers/promises";

test("ACP cannot acknowledge an interaction response after its owned transport closes", async () => {
  const connection = new AcpConnection(acpOptions(), { onNotification() {}, onLoss() {} }, { harness: "opencode", command: process.execPath });
  await connection.connect(1);
  await connection.close();
  const response = connection.respondToNotification("request", { action: "accept", content: {} });
  assert.ok(response && typeof response.then === "function", "interaction response needs an observable write acknowledgement");
  await assert.rejects(response, error => error.code === "ADAPTER_PROTOCOL_ERROR");
});

test("ACP retains a valid semantic prefix before a following framing violation", async () => {
  const order = [];
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const connection = new AcpConnection(acpOptions("inbound-malformed"), {
    captureInbound(message) { return async () => {
      if (message.method === "session/update") { await barrier; order.push("commit"); }
    }; },
    onNotification() { order.push("publish"); },
    onLoss() { order.push("loss"); },
  }, { harness: "opencode", command: process.execPath });
  try {
    await connection.connect(1);
    const response = connection.request("session/new", { cwd: "/tmp", mcpServers: [] }, "createSession");
    const rejected = assert.rejects(response, error => error.code === "ADAPTER_PROTOCOL_ERROR");
    await delay(30);
    release();
    await rejected;
    assert.deepEqual(order, ["commit", "publish", "loss"]);
  } finally { release(); await connection.close(); }
});

test("ACP rejects an oversized unterminated frame without waiting for newline or process exit", { timeout: 2000 }, async () => {
  const connection = new AcpConnection(acpOptions("oversized-frame"), {
    onNotification() {}, onLoss() {},
  }, { harness: "opencode", command: process.execPath });
  try {
    await connection.connect(1);
    const response = connection.request("session/new", { cwd: "/tmp", mcpServers: [] }, "createSession");
    const result = await Promise.race([response.then(() => "resolved", error => error.code), delay(500).then(() => "pending")]);
    assert.equal(result, "ADAPTER_PROTOCOL_ERROR");
  } finally { await connection.close(); }
});

test("ACP persists full messages in receive order before mapped notifications or control results", async () => {
  const persisted = [];
  const published = [];
  let owner = "A";
  let release;
  let captured;
  const received = new Promise(resolve => { captured = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  const connection = new AcpConnection(acpOptions("inbound-order"), {
    captureInbound(message, request) {
      const capturedOwner = owner;
      if (message.method === "session/update") captured();
      return async () => {
        if (message.method === "session/update") await barrier;
        persisted.push({ message, request, owner: capturedOwner });
      };
    },
    onNotification(message) {
      published.push({ message, committed: persisted.at(-1)?.message === message });
    },
    onLoss(error) { throw new Error(JSON.stringify(error)); },
  }, { harness: "opencode", command: process.execPath });
  let requestSettled = false;
  try {
    await connection.connect(1);
    const response = connection.request("session/new", { cwd: "/tmp", mcpServers: [] }, "createSession");
    void response.then(() => { requestSettled = true; }, () => {});
    // On the old transport captureInbound is absent, so keep the red test bounded.
    await Promise.race([received, delay(75)]);
    owner = "B";
    await delay(10);
    assert.equal(requestSettled, false, "a following control response must not bypass a pending semantic commit");
    assert.deepEqual(published, []);
    release();
    await response;
    assert.equal(published[0].committed, true);
    assert.deepEqual(persisted[1].message.params, {
      sessionId: "ordered", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "persist me completely" } },
    });
    assert.equal(persisted[1].owner, "A", "an asynchronous commit must retain its receipt-time owner");
    assert.equal(persisted.at(-1).request.method, "session/new");
    assert.equal(persisted.at(-1).message.result.sessionId, "acp_ses_1");
  } finally { release(); await connection.close(); }
});
