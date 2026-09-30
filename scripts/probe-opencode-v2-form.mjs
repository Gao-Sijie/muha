// Real OpenCode v2.0.11 + local fake OpenAI-compatible model; uses no subscription tokens.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMuhaRuntime } from "@muha-sdk/core";
import { openCodeAdapter } from "@muha-sdk/opencode-adapter";

const root = await mkdtemp(join(tmpdir(), "muha-opencode-v2-form-probe-"));
let asked = false;
const requests = [];
const provider = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  if (request.url !== "/v1/chat/completions") return response.writeHead(404).end();
  const value = JSON.parse(body);
  const tool = value.tools?.find((entry) => entry.function?.name === "question");
  requests.push({ model: value.model, tools: value.tools?.map((entry) => entry.function?.name) ?? [] });
  response.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({
    id: "chatcmpl-muha-form", object: "chat.completion.chunk", created: 0, model: value.model,
    choices: [{ index: 0, delta, finish_reason }],
    ...(finish_reason === null ? {} : { usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }),
  })}\n\n`);
  if (tool && !asked) {
    asked = true;
    chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_muhaprobe", type: "function",
      function: { name: "question", arguments: JSON.stringify({ questions: [{
        header: "Choice", question: "Pick one", options: [
          { label: "First", description: "First option" },
          { label: "Second", description: "Second option" },
        ],
      }] }) } }] });
    chunk({}, "tool_calls");
  } else {
    chunk({ role: "assistant", content: "form-probe-done" });
    chunk({}, "stop");
  }
  response.end("data: [DONE]\n\n");
});
let runtime;
let session;
try {
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  runtime = await createMuhaRuntime({ harnesses: [openCodeAdapter({ env: {
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      model: "muha-probe/tools",
      providers: { "muha-probe": { name: "Muha local probe",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "local-probe" },
        models: { tools: { modelID: "tools", name: "Tool probe",
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          limit: { context: 32768, output: 4096 } } },
      } },
    }),
  }, startupTimeoutMs: 15_000, shutdownTimeoutMs: 5_000 })], dataDir: join(root, "diagnostics") });
  session = await runtime.createSession({ harness: "opencode", workspacePath: root,
    model: "muha-probe/tools", approvalPolicy: "autoApprove" });
  const turn = await session.startTurn([{ type: "text", text: "Ask the user a question." }]);
  const deadline = setTimeout(() => { void runtime.close().catch(() => undefined); }, 15_000);
  const events = [];
  let result;
  try {
    for await (const event of turn) {
      events.push(event);
      if (event.type !== "question.requested") continue;
      assert.equal(event.questions.length, 1);
      const field = event.questions[0];
      assert.equal(field.input.kind, "select");
      await turn.respondToQuestion(event.requestId, { action: "answer", answers: [{
        questionId: field.questionId, kind: "selection",
        optionIds: [field.input.options[1].optionId], customValues: [],
      }] });
    }
    result = await turn.result;
  } finally { clearTimeout(deadline); }
  const summary = { binary: "opencode v2.0.11", model: "muha-probe/tools", asked,
    status: result.status, message: result.message?.text ?? null,
    eventTypes: events.map((event) => event.type), requests };
  console.log(JSON.stringify(summary));
  assert.equal(asked, true);
  assert.equal(result.status, "completed");
  assert.equal(events.filter((event) => event.type === "question.requested").length, 1);
  assert.equal(events.find((event) => event.type === "question.requested")?.toolCallId,
    events.find((event) => event.type === "tool.started")?.toolCallId);
  assert.equal(events.filter((event) => event.type === "question.resolved" && event.outcome === "answered").length, 1);
} catch (error) {
  console.error(JSON.stringify({ message: error instanceof Error ? error.message : String(error),
    code: error?.data?.code ?? error?.code ?? "UNKNOWN", asked, requests }));
  process.exitCode = 1;
} finally {
  await session?.close().catch(() => undefined);
  await runtime?.close().catch(() => undefined);
  await new Promise((resolve) => provider.close(resolve));
  await rm(root, { recursive: true, force: true });
}
