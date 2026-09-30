#!/usr/bin/env node
// Controlled ACP v1 endpoint. Shapes follow @agentclientprotocol/sdk 1.4.0.
// Newline-delimited JSON-RPC 2.0 on stdin/stdout. Scenario via
// MUHA_FAKE_ACP_SCENARIO. No model, no network, no credentials.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const scenario = process.env.MUHA_FAKE_ACP_SCENARIO ?? "normal";
const evidenceFile = process.env.MUHA_FAKE_ACP_EVIDENCE_FILE;
const sessionsFile = process.env.MUHA_FAKE_ACP_SESSIONS_FILE;

// Test-owned process evidence is independent of semantic protocol evidence.
// Holding stdio after supervisor death proves failure cannot wait for EOF.
if (process.env.MUHA_FAKE_ACP_PROCESS_FILE) {
  appendFileSync(process.env.MUHA_FAKE_ACP_PROCESS_FILE,
    `${JSON.stringify({ nativePid: process.pid, helperPid: process.ppid })}\n`);
}
if (process.env.MUHA_FAKE_ACP_HOLD_STDIO === "1") setInterval(() => {}, 1000);

const state = {
  sessions: new Map(),
  nextSession: 1,
  pendingPermission: new Map(),
  pendingElicitation: new Map(),
  pendingHostWaiters: new Map(),
  evidence: {
    scenario,
    requests: [],
    prompts: [],
    permissionReplies: [],
    elicitationReplies: [],
    hostMethodReplies: [],
    cancels: [],
    modelSelections: [],
    effortSelections: [],
  },
};

// Persist Sessions across agent service restarts when a sessions file is given.
if (sessionsFile !== undefined) {
  try {
    const { readFile } = await import("node:fs/promises");
    const seeded = JSON.parse(await readFile(sessionsFile, "utf8"));
    if (Array.isArray(seeded)) {
      for (const session of seeded) {
        if (session?.sessionId && typeof session.sessionId === "string") {
          state.sessions.set(session.sessionId, session);
          state.nextSession = Math.max(state.nextSession, Number(session.sessionId.split("_").at(-1) ?? 0) + 1);
        }
      }
    }
  } catch { /* no seeded sessions */ }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf("\n");
    if (index < 0) break;
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim().length === 0) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    handle(message);
  }
});

function send(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
function respond(id, result) { send({ jsonrpc: "2.0", id, result }); }
function respondError(id, code, message, extra = {}) { send({ jsonrpc: "2.0", id, error: { code, message, ...extra } }); }
function notify(id, method, params) { send({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, params }); }

function persist() {
  // Fixture evidence must be complete before its corresponding wire ACK.
  // Concurrent asynchronous overwrites can splice two different snapshots.
  if (evidenceFile) writeFileSync(evidenceFile, JSON.stringify(state.evidence));
  if (sessionsFile) {
    writeFileSync(sessionsFile, JSON.stringify([...state.sessions.values()]));
  }
}

function handle(message) {
  if (typeof message.method === "string") {
    state.evidence.requests.push({ method: message.method, params: message.params });
    persist();
    void routeRequest(message.method, message.params ?? {}, message.id);
    return;
  }
  // Host reply to one of our notifications/responses.
  handleHostReply(message);
}

function handleHostReply(message) {
  const waiter = state.pendingHostWaiters.get(message.id);
  if (waiter !== undefined) {
    state.pendingHostWaiters.delete(message.id);
    state.evidence.hostMethodReplies.push({ id: message.id, error: message.error, result: message.result });
    persist();
    waiter(message);
    return;
  }
  const permission = state.pendingPermission.get(message.id);
  if (permission !== undefined) {
    state.pendingPermission.delete(message.id);
    state.evidence.permissionReplies.push({ id: message.id, error: message.error, result: message.result });
    persist();
    permission(message);
    return;
  }
  const elicitation = state.pendingElicitation.get(message.id);
  if (elicitation !== undefined) {
    state.pendingElicitation.delete(message.id);
    state.evidence.elicitationReplies.push({ id: message.id, error: message.error, result: message.result });
    persist();
    elicitation(message);
  }
}

async function routeRequest(method, params, id) {
  switch (method) {
    case "initialize":
      if (scenario === "stall-initialize") return;
      if (scenario === "slow-initialize") {
        writeFileSync(process.env.MUHA_FAKE_ACP_INITIALIZING_FILE, JSON.stringify([process.pid, process.ppid]));
        await delay(500);
      }
      if (scenario === "fail-during-peer-initialize") {
        const deadline = Date.now() + 2000;
        while (!existsSync(process.env.MUHA_FAKE_ACP_INITIALIZING_FILE) && Date.now() < deadline) await delay(10);
        respond(id, {}); return;
      }
      if (scenario === "malformed-initialize") { process.stdout.write("{ this is not json }\n"); return; }
      if (params.protocolVersion !== 1 || !params.clientCapabilities || typeof params.clientInfo?.name !== "string") {
        respondError(id, -32602, "ACP v1 requires integer version, clientCapabilities and clientInfo.name"); return;
      }
      if (scenario === "empty-initialize") { respond(id, {}); return; }
      if (scenario === "unknown-initialize-field") { respond(id, { protocolVersion: 1 }); return; }
      {
        const capabilities = { loadSession: true, promptCapabilities: { image: true }, sessionCapabilities: { list: {}, close: {} } };
        if (scenario === "missing-load") capabilities.loadSession = false;
        if (scenario === "missing-image") capabilities.promptCapabilities.image = false;
        if (scenario === "missing-list") delete capabilities.sessionCapabilities.list;
        if (scenario === "missing-close") delete capabilities.sessionCapabilities.close;
        respond(id, { protocolVersion: scenario === "wrong-version" ? 2 : 1,
          agentCapabilities: capabilities, agentInfo: { name: "muha-fake-acp", version: "0.1.0" } });
      }
      return;
    case "session/new": {
      if (scenario === "stall-create") return;
      if (!Array.isArray(params.mcpServers) || typeof params.cwd !== "string") {
        respondError(id, -32602, "cwd and mcpServers required"); return;
      }
      if (scenario === "inbound-order" || scenario === "inbound-malformed") notify(undefined, "session/update", {
        sessionId: "ordered", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "persist me completely" } },
      });
      if (scenario === "inbound-malformed") { process.stdout.write("not-valid-json\n"); return; }
      if (scenario === "oversized-frame") { process.stdout.write("x".repeat(8 * 1024 * 1024 + 1)); return; }
      const sessionId = `acp_ses_${state.nextSession++}`;
      state.sessions.set(sessionId, { sessionId, cwd: params.cwd, title: "Controlled session" });
      persist();
      respond(id, { sessionId, configOptions: configOptions(state.sessions.get(sessionId)) });
      return;
    }
    case "session/load": {
      if (!Array.isArray(params.mcpServers) || typeof params.cwd !== "string") {
        respondError(id, -32602, "cwd and mcpServers required"); return;
      }
      const session = state.sessions.get(params.sessionId);
      if (session === undefined) { respondError(id, -32001, "session_not_found"); return; }
      if (scenario === "resume-identity-drift") { respond(id, { sessionId: "acp_ses_other", cwd: session.cwd }); return; }
      if (params.cwd !== session.cwd) { respondError(id, -32602, "wrong cwd"); return; }
      // Native replay deliberately precedes load's result, without a Turn ID.
      notify(undefined, "session/update", { sessionId: session.sessionId,
        update: { sessionUpdate: "agent_message_chunk", messageId: "historical-message", content: { type: "text", text: "historical replay" } } });
      respond(id, { configOptions: configOptions(session) });
      return;
    }
    case "session/list":
      if (scenario === "invalid-list-cursor") { respond(id, { sessions: [], nextCursor: 42 }); return; }
      respond(id, { sessions: [...state.sessions.values()].map((session) => ({ sessionId: session.sessionId, cwd: session.cwd, title: session.title })) });
      return;
    case "session/set_config_option": {
      const session = state.sessions.get(params.sessionId);
      if (session === undefined) { respondError(id, -32001, "unknown session"); return; }
      if (params.configId === "model" && (scenario === "model-reject" || String(params.value).startsWith("invalid"))) {
        respondError(id, -32602, `model_not_found: ${params.value}`);
        return;
      }
      if (params.configId === "model") {
        session.model = scenario === "model-ack-drift" ? "fixture-default" : params.value;
        state.evidence.modelSelections.push({ sessionId: params.sessionId, model: params.value });
      } else if (["effort", "reasoning_effort"].includes(params.configId)) {
        if (scenario === "effort-reject") { respondError(id, -32602, "effort_not_available"); return; }
        session.effort = params.value;
        state.evidence.effortSelections.push({ sessionId: params.sessionId, effort: params.value });
      } else { respondError(id, -32602, "unknown config id"); return; }
      persist();
      respond(id, { configOptions: configOptions(session) });
      return;
    }
    case "session/prompt": {
      const session = state.sessions.get(params.sessionId);
      if (session === undefined) { respondError(id, -32001, "unknown session"); return; }
      if (session.activePrompt !== undefined) { respondError(id, -32000, "session_busy"); return; }
      if (!Array.isArray(params.prompt) || Object.keys(params).some(key => !["sessionId", "prompt"].includes(key))) {
        respondError(id, -32602, "ACP prompt must be a ContentBlock array without invented fields"); return;
      }
      state.evidence.prompts.push({ sessionId: params.sessionId, parts: params.prompt });
      persist();
      const promptRequestId = `prompt_${state.evidence.prompts.length}`;
      session.activePrompt = { promptRequestId, rpcId: id };
      setTimeout(() => void drivePrompt(session, promptRequestId, params), 5);
      return;
    }
    case "session/cancel": {
      state.evidence.cancels.push(params);
      persist();
      if (id !== undefined) { respondError(id, -32600, "session/cancel must be a notification"); return; }
      if (scenario === "stall-cancel") return;
      const session = state.sessions.get(params.sessionId);
      if (session?.activePrompt !== undefined) {
        if (scenario === "delayed-cancel") await new Promise(resolve => setTimeout(resolve, 200));
        sendUpdate(session, session.activePrompt.promptRequestId, { type: "cancelled" });
        session.activePrompt = undefined;
      }
      return;
    }
    case "session/close":
      if (scenario === "stall-close") return;
      if (scenario === "slow-close") await new Promise(resolve => setTimeout(resolve, 700));
      (state.evidence.closedSessions ??= []).push(params.sessionId);
      // Closing the SDK handle must not delete the native conversation
      // (native Session authority); the Session remains resumable.
      if (scenario === "close-deletes") state.sessions.delete(params.sessionId);
      persist();
      respond(id, {});
      return;
    default:
      respondError(id, -32601, `Unknown ACP method: ${method}`);
  }
}

async function drivePrompt(session, promptRequestId, params) {
  if (scenario === "unsolicited-model-drift") {
    notify(undefined, "session/update", { sessionId: session.sessionId,
      update: { sessionUpdate: "config_option_update", configOptions: configOptions({ ...session, model: "fixture-default" }) } });
  }
  if (["wait-for-cancel", "stall-cancel"].includes(scenario)) return;
  if (scenario === "delayed-cancel" && state.evidence.prompts.length === 1) return;
  if (scenario === "late-old-payload") {
    if (state.evidence.prompts.length > 1) {
      notify(undefined, "session/update", { sessionId: session.sessionId, update: {
        sessionUpdate: "agent_message_chunk", messageId: "m_prompt_1", content: { type: "text", text: "LATE_A_MUST_NOT_ENTER_B" },
      } });
      notify("late-permission", "session/request_permission", { sessionId: session.sessionId,
        toolCall: { toolCallId: "old-tool", name: "bash", title: "Old tool", rawInput: {} },
        options: [{ kind: "allow_once", optionId: "once", name: "Once" }] });
    } else {
      notify(undefined, "session/update", { sessionId: session.sessionId, update: {
        sessionUpdate: "tool_call", toolCallId: "old-tool", name: "bash", title: "Old tool", rawInput: {}, status: "completed", rawOutput: "ok",
      } });
    }
  }
  if (scenario === "rich") {
    process.stderr.write("MUHA_TEST_PROCESS_SECRET_NEVER_PERSIST\n");
    notify(undefined, "_auth/status_update", { authStatus: { secret: "MUHA_TEST_AUTH_SECRET_NEVER_PERSIST" } });
  }
  if (scenario === "inspect-input") { sendFinal(session, promptRequestId, JSON.stringify(params.prompt)); return; }
  if (scenario === "unexpected-exit") { setTimeout(() => process.exit(7), 10); return; }
  if (scenario === "error-status") { sendUpdate(session, promptRequestId, { type: "error", message: "controlled failure", retryable: true }); return; }
  if (scenario === "malformed-frame") { process.stdout.write("not-json-at-all\n"); return; }
  sendUpdate(session, promptRequestId, { type: "started" });

  if (scenario === "fs") {
    const readId = 9001;
    notify(readId, "fs/read_text_file", { sessionId: session.sessionId, path: `${session.cwd}/skills.txt` });
    const readReply = await waitForHostReply(readId);
    const content = readReply?.result?.content ?? "";
    const writeId = 9002;
    notify(writeId, "fs/write_text_file", { sessionId: session.sessionId, path: `${session.cwd}/host-wrote.txt`, content: `host:${String(content).trim()}` });
    const writeReply = await waitForHostReply(writeId);
    const escapeId = 9003;
    notify(escapeId, "fs/read_text_file", { sessionId: session.sessionId, path: "/etc/passwd" });
    const escapeReply = await waitForHostReply(escapeId);
    const terminalId = 9004;
    notify(terminalId, "terminal/create", { sessionId: session.sessionId, command: "echo nope" });
    const terminalReply = await waitForHostReply(terminalId);
    sendFinal(session, promptRequestId, `read=${readReply?.error?.code ?? "none"} write=${writeReply?.error?.code ?? "none"} escape=${escapeReply?.error?.code ?? "none"} terminal=${terminalReply?.error?.code ?? "none"}`);
    return;
  }

  if (scenario === "approval" || scenario === "approval-deny" || scenario === "permission-unknown") {
    // A permission request must reference a Tool Call the host has observed.
    sendUpdate(session, promptRequestId, { type: "started", messages: [{ id: "m_approval", parts: [{ type: "tool_call", callId: `${promptRequestId}_call_1`, name: "bash", input: { command: "npm test" } }] }] });
    const permissionId = "perm_1";
    const replyPromise = requestPermission(session, promptRequestId, permissionId, "Bash: npm test", "Run the test suite", `${promptRequestId}_call_1`);
    if (scenario === "permission-unknown") {
      // Reply to twice to exercise one-shot/late-reply handling.
      const reply = await replyPromise;
      void requestPermission(session, promptRequestId, permissionId, "Late", undefined, `${promptRequestId}_call_1`);
      sendFinal(session, promptRequestId, reply?.result?.outcome?.optionId ?? "none");
      return;
    }
    const reply = await replyPromise;
    sendUpdate(session, promptRequestId, {
      type: "completed",
      messages: [{
        id: `m_${promptRequestId}`, role: "assistant",
        parts: [
          { type: "tool_result", callId: `${promptRequestId}_call_1`, output: "done", isError: false },
          { type: "text", text: reply?.result?.outcome?.optionId === "allow-once" ? "approved" : "declined", delta: false },
        ],
      }],
    });
    return;
  }

  if (scenario === "permission-race") {
    sendUpdate(session, promptRequestId, { type: "started", messages: [{ id: "m_race", parts: [{ type: "tool_call", callId: `${promptRequestId}_call_1`, name: "bash", input: { command: "npm test" } }] }] });
    void requestPermission(session, promptRequestId, "perm_race", "Race", undefined, `${promptRequestId}_call_1`);
    setTimeout(() => sendUpdate(session, promptRequestId, {
      type: "completed",
      messages: [{ id: "m_race_final", role: "assistant", parts: [{ type: "tool_result", callId: `${promptRequestId}_call_1`, output: "done", isError: false }, { type: "text", text: "completed-before-reply", delta: false }] }],
    }), 10);
    return;
  }

  if (["question", "question-dismiss", "question-orphan", "mcp-form"].includes(scenario)) {
    const reply = await requestElicitation(scenario === "question-orphan" ? { sessionId: "missing-session" } : session, promptRequestId, "elicit_1", [
      { questionId: "q1", header: "Target", question: "Choose a target", options: [{ label: "Staging" }, { label: "Production" }], multiple: false, allowCustom: true },
    ]);
    sendFinal(session, promptRequestId, reply?.result?.action === "accept" ? "answered" : "dismissed");
    return;
  }

  if (scenario === "rich") {
    const parts = [
      { type: "reasoning", text: "Thinking", delta: true },
      { type: "text", text: "Hello ", delta: true },
      { type: "tool_call", callId: "call_1", name: "bash", input: { command: "npm test" } },
      { type: "tool_call_update", callId: "call_1", update: { title: "Running" } },
      { type: "tool_result", callId: "call_1", output: "ok", isError: false },
      { type: "text", text: "world", delta: true },
      { type: "usage", inputTokens: 10, outputTokens: 3, cachedInputTokens: 1, reasoningTokens: 2 },
    ];
    sendUpdate(session, promptRequestId, { type: "completed", messages: [{ id: `m_${promptRequestId}`, role: "assistant", parts }] });
    return;
  }

  if (scenario === "duplicate-terminal") {
    sendFinal(session, promptRequestId, "first");
    sendFinal(session, promptRequestId, "second");
    return;
  }

  sendFinal(session, promptRequestId, `echo:${params.prompt.map((part) => part.text ?? "image").join(" ")}`);
}

function waitForHostReply(id) {
  return new Promise((resolve) => { state.pendingHostWaiters.set(id, resolve); });
}

function requestPermission(session, promptRequestId, permissionId, title, explanation, callId) {
  return new Promise((resolve) => {
    state.pendingPermission.set(permissionId, resolve);
    notify(permissionId, "session/request_permission", {
      sessionId: session.sessionId,
      toolCall: { toolCallId: callId, title, name: "bash", rawInput: { command: "npm test" }, status: "pending" },
      options: [
        { optionId: "allow-once", kind: "allow_once", name: "Allow once" },
        { optionId: "allow-always", kind: "allow_always", name: "Always allow" },
        { optionId: "reject-once", kind: "reject_once", name: "Reject once" },
      ],
    });
  });
}

function requestElicitation(session, promptRequestId, elicitationId, questions) {
  return new Promise((resolve) => {
    state.pendingElicitation.set(elicitationId, resolve);
    const properties = {};
    for (const question of questions) {
      properties[question.questionId] = { type: "string", title: question.question, description: question.header,
        oneOf: [...question.options.map(option => ({ const: option.label, title: option.label })), { const: "None of the above", title: "None of the above" }],
        _meta: { codex: { isOther: true, isSecret: false } } };
      properties[`${question.questionId}_note`] = { type: "string", title: "Additional answer or note",
        _meta: { codex: { questionId: question.questionId, role: "user_note", isSecret: false } } };
    }
    notify(elicitationId, "elicitation/create", { sessionId: session.sessionId, toolCallId: `question_${promptRequestId}`, mode: "form",
      message: "Codex needs your input to continue.", requestedSchema: { type: "object", properties, required: questions.map(q => q.questionId) },
      ...(scenario === "mcp-form" ? {} : { _meta: { codex: { autoResolutionMs: null } } }) });
  });
}

function sendUpdate(session, promptRequestId, status) {
  const { messages, ...statusOnly } = status;
  const prompt = session.activePrompt;
  if (prompt?.promptRequestId !== promptRequestId) return;
  for (const message of messages ?? []) for (const part of message.parts) {
    if (part.type === "text" || part.type === "reasoning") {
      notify(undefined, "session/update", { sessionId: session.sessionId, update: {
        sessionUpdate: part.type === "text" ? "agent_message_chunk" : "agent_thought_chunk",
        messageId: message.id, content: { type: "text", text: part.text },
      } });
    } else if (part.type === "tool_call") {
      notify(undefined, "session/update", { sessionId: session.sessionId, update: {
        sessionUpdate: "tool_call", toolCallId: part.callId, name: part.name, title: part.name, rawInput: part.input, status: "pending",
      } });
    } else if (part.type === "tool_call_update" || part.type === "tool_result") {
      notify(undefined, "session/update", { sessionId: session.sessionId, update: {
        sessionUpdate: "tool_call_update", toolCallId: part.callId,
        ...(part.type === "tool_result" ? { status: part.isError ? "failed" : "completed", rawOutput: part.output } : { ...part.update, status: "in_progress" }),
      } });
    } else if (part.type === "usage") {
      // Context occupancy is deliberately different from Turn token usage.
      notify(undefined, "session/update", { sessionId: session.sessionId, update: { sessionUpdate: "usage_update", used: 1234, size: 10000 } });
    }
  }
  if (statusOnly.type === "error") {
    respondError(prompt.rpcId, -32603, statusOnly.message);
    session.activePrompt = undefined;
  } else if (["completed", "cancelled"].includes(statusOnly.type)) {
    respond(prompt.rpcId, { stopReason: statusOnly.type === "completed" ? "end_turn" : "cancelled",
      ...(["rich", "delayed-cancel"].includes(scenario) ? { usage: { inputTokens: 10, outputTokens: 3, totalTokens: 14, cachedReadTokens: 1, thoughtTokens: 2 } } : {}) });
    session.activePrompt = undefined;
  }
}

function configOptions(session) {
  if (scenario === "missing-model-config") return [];
  return [
    { id: "model", name: "Model", type: "select", currentValue: session.model ?? "fixture-default", options: ["fixture-default", "opencode-go/deepseek-v4.1-flash", "gpt-5.6-luna"].map(value => ({ value, name: value })) },
    ...["effort", "reasoning_effort"].map(id => ({ id, name: "Effort", type: "select", currentValue: session.effort ?? "medium", options: ["low", "medium", "high", "xhigh"].map(value => ({ value, name: value })) })),
  ];
}

function sendFinal(session, promptRequestId, text) {
  sendUpdate(session, promptRequestId, {
    type: "completed",
    messages: [{ id: `m_${promptRequestId}`, role: "assistant", parts: [{ type: "text", text, delta: false }] }],
  });
}

process.on("SIGTERM", () => process.exit(0));
persist();
