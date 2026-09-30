// Real OpenCode v2 binary + local fake OpenAI-compatible provider; no subscription tokens.
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createMuhaRuntime } from "@muha-sdk/core";
import { openCodeAdapter } from "@muha-sdk/opencode-adapter";

const root = await mkdtemp(join(tmpdir(), "muha-opencode-v2-runtime-probe-"));
const requests = [];
const provider = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  if (request.url !== "/v1/chat/completions") return response.writeHead(404).end();
  const value = JSON.parse(body);
  const user = value.messages?.findLast((message) => message.role === "user");
  requests.push({ model: value.model, roles: value.messages?.map((message) => message.role),
    image: body.includes("image_url"),
    partOrder: Array.isArray(user?.content) ? user.content.map((part) => part.type) : null });
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(`data: ${JSON.stringify({ id: "chatcmpl-muha-runtime", object: "chat.completion.chunk",
    created: 0, model: value.model,
    choices: [{ index: 0, delta: { role: "assistant", content: "local-ok" }, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ id: "chatcmpl-muha-runtime", object: "chat.completion.chunk",
    created: 0, model: value.model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } })}\n\n`);
  response.end("data: [DONE]\n\n");
});
let runtime;
let session;
try {
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  runtime = await createMuhaRuntime({
    harnesses: [openCodeAdapter({ env: {
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        model: "muha-probe/image",
        providers: { "muha-probe": {
          name: "Muha local probe", package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: "local-probe" },
          models: { image: { modelID: "image", name: "Image probe",
            capabilities: { tools: false, input: ["text", "image"], output: ["text"] },
            limit: { context: 32768, output: 4096 } } },
        } },
      }),
    }, startupTimeoutMs: 15_000, shutdownTimeoutMs: 5_000 })],
    dataDir: join(root, "diagnostics"),
  });
  session = await runtime.createSession({ harness: "opencode", workspacePath: root,
    model: "muha-probe/image", approvalPolicy: "autoDeny" });
  const turn = await session.startTurn([{ type: "text", text: "Say local-ok." }]);
  const interruptAtDeadline = setTimeout(() => { void runtime.close().catch(() => undefined); }, 5_000);
  const events = [];
  let result;
  try {
    for await (const event of turn) events.push(event);
    result = await turn.result;
  } finally { clearTimeout(interruptAtDeadline); }
  const imageTurn = await session.startTurn([
    { type: "image", source: { type: "base64", mediaType: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" } },
    { type: "text", text: "Describe this image." },
  ]);
  const imageDeadline = setTimeout(() => { void runtime.close().catch(() => undefined); }, 5_000);
  const imageEvents = [];
  let imageResult;
  try {
    for await (const event of imageTurn) imageEvents.push(event);
    imageResult = await imageTurn.result;
  } finally { clearTimeout(imageDeadline); }
  console.log(JSON.stringify({ binary: "opencode v2", model: "muha-probe/image",
    status: result.status, error: result.error ?? null, usage: result.usage ?? null,
    message: result.message?.text ?? null, eventTypes: events.map((event) => event.type),
    imageStatus: imageResult.status, imageError: imageResult.error ?? null,
    imageEventTypes: imageEvents.map((event) => event.type),
    nativeTrace: traceNative(), requests }));
  if (result.status !== "completed" || imageResult.status !== "completed" ||
      !requests.some((request) => JSON.stringify(request.partOrder) === JSON.stringify(["image_url", "text"]))) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(JSON.stringify({ code: error?.data?.code ?? error?.code ?? "UNKNOWN",
    nativeCode: error?.data?.nativeCode ?? null,
    message: error instanceof Error ? error.message : String(error), nativeTrace: traceNative(), requests }));
  process.exitCode = 1;
} finally {
  await session?.close().catch(() => undefined);
  await runtime?.close().catch(() => undefined);
  await new Promise((resolve) => provider.close(resolve));
  await rm(root, { recursive: true, force: true });
}

function traceNative() {
  let database;
  try {
    database = new DatabaseSync(join(root, "diagnostics", "diagnostic-events.sqlite"), { readOnly: true });
    return database.prepare("SELECT payload_json FROM native_event_records ORDER BY rowid").all()
      .map(({ payload_json }) => JSON.parse(payload_json))
      .filter((event) => typeof event.type === "string")
      .map((event) => ({ type: event.type, seq: event.durable?.seq,
        ...(["session.execution.started", "session.inbox.delivered", "session.inbox.enqueued"].includes(event.type)
          ? { dataKeys: Object.keys(event.data ?? {}), inboxID: event.data?.inboxID ?? null } : {}),
        errorName: event.type === "session.execution.failed" ? event.data?.error?.name : undefined }));
  } catch { return []; }
  finally { database?.close(); }
}
