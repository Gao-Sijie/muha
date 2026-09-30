import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMuhaRuntime } from "@muha-sdk/core";
import { piAdapter } from "@muha-sdk/pi-adapter";

test("a consumer completes a Pi text Turn through an isolated SDK Session", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-pi-text-"));
  const workspace = join(root, "workspace"), agentDir = join(root, "agent");
  await Promise.all([mkdir(workspace), mkdir(agentDir)]);
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = { id: "controlled", object: "chat.completion.chunk", created: 1, model: "controlled",
      choices: [{ index: 0, delta: { role: "assistant", content: "Hello from Pi." }, finish_reason: null }] };
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    response.end(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { controlled: {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "controlled-only",
    models: [{ id: "controlled", name: "controlled", reasoning: false, input: ["text", "image"],
      contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  let runtime;
  try {
    runtime = await createMuhaRuntime({ harnesses: [piAdapter({ env: { PI_CODING_AGENT_DIR: agentDir },
      startupTimeoutMs: 10000, shutdownTimeoutMs: 2000 })], dataDir: join(root, "diagnostics") });
    await assert.rejects(runtime.createSession({ harness: "pi", workspacePath: workspace }),
      error => error.data.code === "UNSUPPORTED_CAPABILITY");
    const session = await runtime.createSession({ harness: "pi", workspacePath: workspace,
      model: "controlled/controlled", approvalPolicy: "autoApprove" });
    const turn = await session.startTurn([{ type: "text", text: "Hello" }]);
    const events = [];
    for await (const event of turn) events.push(event);
    const result = await turn.result;
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(result.message.text, "Hello from Pi.");
    assert.deepEqual(events.filter(e => ["turn.completed", "turn.failed", "turn.interrupted"].includes(e.type)).map(e => e.type), ["turn.completed"]);
    assert.equal(events.some(e => e.type.startsWith("approval.")), false);
    assert.ok(requests.length > 0);
    await session.close();
  } finally {
    await runtime?.close();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
