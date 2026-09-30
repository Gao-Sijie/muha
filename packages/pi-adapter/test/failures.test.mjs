import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { controlledPi, completedTurn } from "./support/controlled-pi.mjs";

test("Pi preserves Core empty-message semantics and rejects missing messages as protocol failures", async t => {
  const fixture = await controlledPi(t, (_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: "empty", object: "chat.completion.chunk", created: 1, model: "controlled",
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await mkdir(join(fixture.agentDir, "extensions"));
  await writeFile(join(fixture.agentDir, "extensions", "no-message.ts"), `
    export default pi => pi.registerCommand("no-message", { handler: async () => {} });
  `);
  const runtime = await fixture.runtime();
  const session = await runtime.createSession({ harness: "pi", workspacePath: fixture.workspace,
    model: "controlled/controlled", approvalPolicy: "autoApprove", turnRetryPolicy: { maxRetries: 1 } });
  const empty = await completedTurn(session, "Empty final");
  assert.equal(empty.result.status, "completed");
  assert.equal(empty.result.message.text, "");
  const missing = await completedTurn(session, "/no-message");
  assert.equal(missing.result.status, "failed");
  assert.equal(missing.result.error.code, "ADAPTER_PROTOCOL_ERROR");
  assert.equal(missing.events.some(event => event.type === "turn.retrying"), false);
});

for (const [label, message] of [
  ["malformed message", null],
  ["unknown command correlation", { type: "reply", id: "unknown-command", value: null }],
  ["invalid native field", { type: "native", event: { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: 1 } } }],
]) {
  test(`Pi quarantines ${label} as a protocol failure without Harness retries`, { timeout: 10000 }, async t => {
    const fixture = await controlledPi(t, () => {});
    await mkdir(join(fixture.agentDir, "extensions"));
    await writeFile(join(fixture.agentDir, "extensions", "invalid-protocol.ts"), `
      export default pi => pi.on("agent_start", () => { setTimeout(() => process.send(${JSON.stringify(message)}), 20); });
    `);
    const runtime = await fixture.runtime();
    const session = await runtime.createSession({ harness: "pi", workspacePath: fixture.workspace,
      model: "controlled/controlled", approvalPolicy: "autoApprove", turnRetryPolicy: { maxRetries: 1 } });
    const { result, events } = await completedTurn(session, "Wait for malformed control output");
    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "ADAPTER_PROTOCOL_ERROR");
    assert.equal(events.some(event => event.type === "turn.retrying"), false);
    assert.equal(session.status.status, "closed");
    assert.equal(runtime.status, "active", "A classified protocol rejection is not unexpected owned process loss");
  });
}
