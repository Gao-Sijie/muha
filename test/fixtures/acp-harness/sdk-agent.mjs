// Independent interoperability fixture: request validation and reply framing
// are owned by the pinned upstream ACP SDK, not Muha's handwritten fixture.
import { agent, ndJsonStream, RequestError } from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

const sessions = new Map();
const config = session => [
  { id: "model", name: "Model", type: "select", currentValue: session.model,
    options: [{ value: "fixture-model", name: "Fixture model" }] },
  { id: "effort", name: "Effort", type: "select", currentValue: session.effort,
    options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
];
const requireSession = id => {
  const session = sessions.get(id);
  if (!session) throw new RequestError(-32602, "No such Session");
  return session;
};

const app = agent()
  .onRequest("initialize", () => ({ protocolVersion: 1, agentCapabilities: {
    loadSession: true, promptCapabilities: { image: true }, sessionCapabilities: { list: {}, close: {} },
  } }))
  .onRequest("session/new", ({ params }) => {
    const sessionId = `sdk-${sessions.size + 1}`;
    const session = { id: sessionId, cwd: params.cwd, model: "fixture-model", effort: "low" };
    sessions.set(sessionId, session);
    return { sessionId, configOptions: config(session) };
  })
  .onRequest("session/load", async ({ params, client }) => {
    const session = requireSession(params.sessionId);
    if (session.cwd !== params.cwd) throw new RequestError(-32602, "Wrong Workspace");
    await client.notify("session/update", { sessionId: session.id, update: {
      sessionUpdate: "agent_message_chunk", messageId: "old-message", content: { type: "text", text: "old history" },
    } });
    return { configOptions: config(session) };
  })
  .onRequest("session/list", ({ params }) => {
    const entries = [...sessions.values()].filter(s => s.cwd === params.cwd);
    const offset = Number(params.cursor ?? "0");
    return { sessions: entries.slice(offset, offset + 1).map(s => ({ sessionId: s.id, cwd: s.cwd })),
      ...(offset + 1 < entries.length ? { nextCursor: String(offset + 1) } : {}) };
  })
  .onRequest("session/set_config_option", ({ params }) => {
    const session = requireSession(params.sessionId);
    if (!["model", "effort"].includes(params.configId)) throw new RequestError(-32602, "Unknown config");
    session[params.configId] = params.value;
    return { configOptions: config(session) };
  })
  .onRequest("session/close", ({ params }) => { requireSession(params.sessionId); return {}; })
  .onNotification("session/cancel", ({ params }) => { requireSession(params.sessionId).cancel?.(); })
  .onRequest("session/prompt", async ({ params, client }) => {
    const session = requireSession(params.sessionId);
    const text = params.prompt.filter(part => part.type === "text").map(part => part.text).join("");
    if (text === "wait") return new Promise(resolve => { session.cancel = () => resolve({ stopReason: "cancelled" }); });
    if (text === "permission") {
      const toolCall = { toolCallId: `${session.id}-tool`, name: "bash", title: "Run test", rawInput: { command: "npm test" }, status: "pending" };
      await client.notify("session/update", { sessionId: session.id, update: { sessionUpdate: "tool_call", ...toolCall } });
      const reply = await client.request("session/request_permission", { sessionId: session.id, toolCall, options: [
        { kind: "allow_always", optionId: "always", name: "Always" },
        { kind: "allow_once", optionId: "once", name: "Once" },
        { kind: "reject_once", optionId: "no", name: "No" },
      ] });
      if (reply.outcome.outcome !== "selected" || reply.outcome.optionId !== "once") throw new RequestError(-32603, "One-shot permission not received");
      await client.notify("session/update", { sessionId: session.id, update: { sessionUpdate: "tool_call_update", toolCallId: toolCall.toolCallId, status: "completed", rawOutput: "ok" } });
    }
    await client.notify("session/update", { sessionId: session.id, update: {
      sessionUpdate: "agent_message_chunk", messageId: crypto.randomUUID(), content: { type: "text", text: `sdk:${text}` },
    } });
    return { stopReason: "end_turn" };
  });
const connection = app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
await connection.closed;
