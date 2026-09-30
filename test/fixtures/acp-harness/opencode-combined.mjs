// A single real ACP SDK endpoint and native HTTP observer, with independent
// OpenCode wire shapes. Native prompt submission is deliberately unavailable.
import { agent, ndJsonStream, RequestError } from "@agentclientprotocol/sdk";
import { createServer } from "node:http";
import { Readable, Writable } from "node:stream";

const sessions = new Map();
const streams = new Set();
const questions = new Map();
const permissions = new Map();
const permissionReplies = [];
let nextEvent = 0;
const authorization = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`;
const model = "fixture/model";
const config = session => [
  { id: "model", name: "Model", type: "select", currentValue: session.model, options: [{ value: model, name: model }] },
];
const json = (response, status, value) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
const emit = (session, type, properties) => {
  for (const stream of streams) if (stream.cwd === session.directory) stream.response.write(`data: ${JSON.stringify({ id: `event-${++nextEvent}`, type, properties })}\n\n`);
};
const server = createServer(async (request, response) => {
  if (request.headers.authorization !== authorization) return response.writeHead(401).end();
  const path = new URL(request.url, "http://localhost").pathname;
  if (path === "/global/health") {
    if (process.env.MUHA_FAKE_OPENCODE_COMBINED_SCENARIO === "native-health-stall") return;
    return json(response, 200, { healthy: true, version: "fixture-opencode" });
  }
  if (path === "/event") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    const stream = { response, cwd: request.headers["x-opencode-directory"] };
    streams.add(stream);
    response.write(`data: ${JSON.stringify({ id: `event-${++nextEvent}`, type: "server.connected", properties: {} })}\n\n`);
    request.on("close", () => streams.delete(stream));
    return;
  }
  if (path === "/provider") return json(response, 200, { all: [{ id: "fixture", models: { model: { variants: {} } } }] });
  const permission = /^\/permission\/([^/]+)\/reply$/.exec(path);
  if (permission) {
    let source = "";
    for await (const chunk of request) source += chunk;
    const reply = JSON.parse(source).reply;
    permissionReplies.push({ id: permission[1], reply });
    const pending = permissions.get(permission[1]);
    json(response, 200, true);
    if (pending) {
      emit(pending.session, "permission.replied", { sessionID: pending.session.id, requestID: permission[1] });
      pending.resolve(reply);
    }
    return;
  }
  const match = /^\/session\/([^/]+)(\/message|\/children)?$/.exec(path);
  if (match && request.method === "GET") {
    const session = sessions.get(match[1]);
    if (!session) return json(response, 404, {});
    if (match[2] === "/message") return json(response, 200, session.messages);
    if (match[2] === "/children") return json(response, 200, []);
    return json(response, 200, { id: session.id, directory: session.directory });
  }
  const question = /^\/question\/([^/]+)\/(reply|reject)$/.exec(path);
  if (question && questions.has(question[1])) {
    let source = "";
    for await (const chunk of request) source += chunk;
    const pending = questions.get(question[1]);
    questions.delete(question[1]);
    const answers = source ? JSON.parse(source).answers : undefined;
    emit(pending.session, question[2] === "reply" ? "question.replied" : "question.rejected", {
      sessionID: pending.session.id, requestID: question[1], ...(answers ? { answers } : {}),
    });
    json(response, 200, true);
    pending.resolve(answers?.[0]?.[0] ?? "dismissed");
    return;
  }
  // A fallback or second executor cannot accidentally pass this fixture.
  return json(response, 405, { error: "native execution is prohibited" });
});
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));

const requireSession = id => { const session = sessions.get(id); if (!session) throw new RequestError(-32602, "No Session"); return session; };
const app = agent()
  .onRequest("initialize", () => ({ protocolVersion: 1, agentCapabilities: {
    loadSession: true, promptCapabilities: { image: true }, sessionCapabilities: { list: {}, close: {} },
  } }))
  .onRequest("session/new", ({ params }) => {
    const session = { id: `ses-${sessions.size + 1}`, directory: params.cwd, model, messages: [], turns: 0 };
    sessions.set(session.id, session);
    return { sessionId: session.id, configOptions: config(session) };
  })
  .onRequest("session/load", ({ params }) => ({ configOptions: config(requireSession(params.sessionId)) }))
  .onRequest("session/list", ({ params }) => ({ sessions: [...sessions.values()].filter(s => s.directory === params.cwd).map(s => ({ sessionId: s.id, cwd: s.directory })) }))
  .onRequest("session/set_config_option", ({ params }) => {
    const session = requireSession(params.sessionId); session.model = params.value;
    return { configOptions: config(session) };
  })
  .onRequest("session/close", () => ({}))
  .onRequest("session/prompt", async ({ params, client }) => {
    const session = requireSession(params.sessionId);
    const prefix = `${session.id}-${++session.turns}`;
    const user = { info: { id: `${prefix}-user`, sessionID: session.id, role: "user", model: { providerID: "fixture", modelID: "model" } }, parts: [] };
    session.messages.push(user);
    emit(session, "message.updated", { info: user.info });
    const tool = { id: `${prefix}-part`, sessionID: session.id, messageID: `${prefix}-step1`, callID: `${prefix}-call`, type: "tool", tool: "question", state: { status: "running", input: { question: "Choose" } } };
    const step = { info: { id: tool.messageID, sessionID: session.id, role: "assistant", time: {}, tokens: { input: 10, output: 3, reasoning: 2, cache: { read: 4 } } }, parts: [tool] };
    session.messages.push(step);
    emit(session, "message.updated", { info: step.info });
    emit(session, "message.part.updated", { part: tool });
    const update = value => client.notify("session/update", { sessionId: session.id, update: value });
    if (process.env.MUHA_FAKE_OPENCODE_COMBINED_SCENARIO === "rpc-error-before-native-idle") {
      step.info.time.completed = Date.now();
      setTimeout(() => {
        emit(session, "message.updated", { info: step.info });
        emit(session, "session.error", { sessionID: session.id, error: { name: "APIError", data: { message: "native retryable failure", isRetryable: true } } });
        emit(session, "session.status", { sessionID: session.id, status: { type: "idle" } });
      }, 60);
      throw new RequestError(-32603, "opaque bridge failure");
    }
    await update({ sessionUpdate: "tool_call", toolCallId: tool.callID, title: "Choose", status: "pending", rawInput: tool.state.input });
    if (process.env.MUHA_FAKE_OPENCODE_COMBINED_SCENARIO === "denied-empty-final") {
      await client.request("session/request_permission", { sessionId: session.id,
        toolCall: { toolCallId: tool.callID, title: "Run tool", status: "pending" },
        options: [{ optionId: "once", kind: "allow_once", name: "Allow once" }, { optionId: "reject", kind: "reject_once", name: "Reject" }] });
      tool.state = { ...tool.state, status: "error", error: "The user rejected permission to use this specific tool call." };
      step.info.time.completed = Date.now();
      step.info.finish = "tool-calls";
      emit(session, "message.part.updated", { part: tool });
      emit(session, "message.updated", { info: step.info });
      await update({ sessionUpdate: "tool_call_update", toolCallId: tool.callID, status: "failed" });
      setTimeout(() => emit(session, "session.status", { sessionID: session.id, status: { type: "idle" } }), 25);
      return { stopReason: "end_turn" };
    }
    if (process.env.MUHA_FAKE_OPENCODE_COMBINED_SCENARIO === "descendants") {
      const child = { id: `${session.id}-child`, directory: session.directory, parentID: session.id };
      sessions.set(child.id, { ...child, messages: [] });
      emit(session, "session.created", { info: child });
      const permitted = new Promise(resolve => permissions.set(`${prefix}-child-permission`, { session: child, resolve }));
      const asked = (id, sessionID) => emit(session, "permission.asked", { id, sessionID, permission: "bash", patterns: ["npm test"], metadata: { command: "npm test" } });
      asked(`${prefix}-peer-permission`, "independent-peer");
      asked(`${prefix}-child-permission`, child.id);
      if (await permitted !== "once" || permissionReplies.some(reply => reply.id === `${prefix}-peer-permission`)) throw new RequestError(-32603, "Descendant permissions crossed ownership or were persistent");
    }
    // Exercise native Question arriving before the corresponding ACP start.
    const answer = new Promise(resolve => questions.set(prefix, { session, resolve }));
    emit(session, "question.asked", { id: prefix, sessionID: session.id, tool: { messageID: tool.messageID, callID: tool.callID }, questions: [{ header: "Target", question: "Choose", options: [{ label: "Staging", description: "Safe" }, { label: "Production", description: "Live" }] }] });
    if (process.env.MUHA_FAKE_OPENCODE_COMBINED_SCENARIO === "stream-loss-before-tool") {
      for (const stream of streams) if (stream.cwd === session.directory) stream.response.end();
      return answer.then(() => ({ stopReason: "end_turn" }));
    }
    await update({ sessionUpdate: "tool_call_update", toolCallId: tool.callID, status: "in_progress" });
    const selected = await answer;
    tool.state = { ...tool.state, status: "completed", output: selected };
    emit(session, "message.part.updated", { part: tool });
    await update({ sessionUpdate: "tool_call_update", toolCallId: tool.callID, status: "completed", rawOutput: { output: selected, metadata: {} } });
    step.info.time.completed = Date.now();
    emit(session, "message.updated", { info: step.info });
    const final = { info: { id: `${prefix}-step2`, sessionID: session.id, role: "assistant", time: { completed: Date.now() }, tokens: { input: 20, output: 5, reasoning: 1, cache: { read: 8 } } }, parts: [{ type: "text", text: selected }] };
    session.messages.push(final);
    emit(session, "message.updated", { info: final.info });
    await update({ sessionUpdate: "agent_message_chunk", messageId: final.info.id, content: { type: "text", text: selected } });
    // ACP's final usage is only the final step, deliberately not 30/8/3/12.
    setTimeout(() => emit(session, "session.status", { sessionID: session.id, status: { type: "idle" } }), 25);
    return { stopReason: "end_turn", usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25, cachedReadTokens: 8, thoughtTokens: 1 } };
  });
const connection = app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
await connection.closed;
server.closeAllConnections();
server.close();
