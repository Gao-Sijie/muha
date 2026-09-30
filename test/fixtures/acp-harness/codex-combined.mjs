// Independent ACP SDK bridge over the existing native Codex protocol fixture.
// Like upstream, deliberately leaves native Tool details out of ACP messages.
import { agent, ndJsonStream } from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { Readable, Writable } from "node:stream";
import { writeFileSync } from "node:fs";

const child = spawn(process.env.CODEX_PATH, ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
if (process.env.MUHA_FAKE_COMBINED_PROCESSES) writeFileSync(process.env.MUHA_FAKE_COMBINED_PROCESSES,
  JSON.stringify({ bridgePid: process.pid, helperPid: process.ppid, observerPid: child.pid }));
child.stderr.resume();
let nextId = 0;
const pending = new Map();
const sessions = new Map();
const turns = new Map();
const delayedStarts = new Map();
const send = message => child.stdin.write(`${JSON.stringify(message)}\n`);
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = ++nextId; pending.set(id, { resolve, reject }); send({ id, method, params });
});
const native = (async () => {
  for await (const line of createInterface({ input: child.stdout })) {
    const message = JSON.parse(line);
    if (message.id !== undefined && message.method === undefined) {
      const waiter = pending.get(message.id); pending.delete(message.id);
      if (message.error) waiter?.reject(new Error(message.error.message)); else waiter?.resolve(message.result);
      continue;
    }
    const turn = turns.get(message.params?.threadId);
    if (!turn) continue;
    const params = message.params;
    const item = params.item;
    const update = value => turn.client.notify("session/update", { sessionId: params.threadId, update: value });
    if (item?.type === "imageView") {
      if (message.method === "item/started") {
        const tool = { sessionUpdate: "tool_call", toolCallId: item.id, title: "View image", status: "completed", rawInput: { path: item.path } };
        if (process.env.MUHA_FAKE_STALL_IMAGE_VIEW === "1") {
          // One small pipe write queues a later complete semantic message
          // behind the Tool mapping that waits for native completion.
          const marker = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "QUEUED_AFTER_BLOCKED_TOOL" } };
          process.stdout.write([tool, marker].map(update => JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: params.threadId, update } })).join("\n") + "\n");
        } else await update(tool);
      }
    } else if (item && ["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch", "imageGeneration", "contextCompaction", "collabAgentToolCall", "subAgentActivity"].includes(item.type)) {
      if (process.env.MUHA_FAKE_COMPLETED_TOOL_INPUT === "1") {
        if (message.method === "item/started") { delayedStarts.set(item.id, item); continue; }
        await update({ sessionUpdate: "tool_call", toolCallId: delayedStarts.get(item.id).id, title: "Tool", status: "in_progress" });
        delayedStarts.delete(item.id);
      }
      await update(message.method === "item/started"
        ? { sessionUpdate: "tool_call", toolCallId: item.id, title: "Tool", status: "in_progress" }
        : { sessionUpdate: "tool_call_update", toolCallId: item.id, status: item.status === "failed" ? "failed" : "completed", rawOutput: { lossyAcpPlaceholder: true } });
    } else if (message.method === "item/agentMessage/delta" || message.method === "item/reasoning/summaryTextDelta") {
      await update({ sessionUpdate: message.method === "item/agentMessage/delta" ? "agent_message_chunk" : "agent_thought_chunk", messageId: params.itemId, content: { type: "text", text: params.delta } });
    } else if (message.method === "turn/completed") {
      turn.resolve({ stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
      turns.delete(params.threadId);
    }
  }
})();
const config = session => [
  { id: "model", name: "Model", type: "select", currentValue: session.model, options: [{ value: session.model, name: session.model }] },
  { id: "reasoning_effort", name: "Effort", type: "select", currentValue: "medium", options: [{ value: "medium", name: "Medium" }] },
];
const app = agent()
  .onRequest("initialize", async () => {
    await rpc("initialize", { clientInfo: { name: "fixture", version: "1" }, capabilities: null });
    send({ method: "initialized" });
    return { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, sessionCapabilities: { list: {}, close: {} } } };
  })
  .onRequest("session/new", async ({ params }) => {
    const response = await rpc("thread/start", { cwd: params.cwd, approvalPolicy: "on-request", sandbox: "workspace-write" });
    const session = { id: response.thread.id, cwd: params.cwd, model: response.model, effort: "medium", mode: "read-only" };
    sessions.set(session.id, session);
    return { sessionId: session.id, configOptions: config(session) };
  })
  .onRequest("session/set_config_option", ({ params }) => {
    const session = sessions.get(params.sessionId);
    if (params.configId === "model") session.model = params.value;
    else session.effort = params.value;
    return { configOptions: config(session) };
  })
  .onRequest("session/set_mode", ({ params }) => { sessions.get(params.sessionId).mode = params.modeId; return {}; })
  .onRequest("session/close", async ({ params }) => { await rpc("thread/unsubscribe", { threadId: params.sessionId }); return {}; })
  .onRequest("session/prompt", ({ params, client }) => new Promise((resolve, reject) => {
    turns.set(params.sessionId, { client, resolve });
    const session = sessions.get(params.sessionId);
    const automatic = session.mode === "agent-full-access";
    const drift = process.env.MUHA_FAKE_CODEX_COMBINED_DRIFT;
    void rpc("turn/start", { threadId: drift === "identity" ? "wrong-native-session" : params.sessionId, model: drift === "model" ? "wrong-model" : session.model,
      effort: drift === "effort" ? "high" : session.effort,
      approvalPolicy: drift === "policy" ? "never" : automatic ? "never" : "on-request",
      sandboxPolicy: { type: automatic ? "dangerFullAccess" : "workspaceWrite" },
      input: params.prompt.filter(part => part.type === "text").map(part => ({ type: "text", text: part.text, text_elements: [] })) }).catch(reject);
  }));
const connection = app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
await connection.closed;
child.stdin.end();
await native;
