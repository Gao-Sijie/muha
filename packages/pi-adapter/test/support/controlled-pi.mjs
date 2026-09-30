import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMuhaRuntime } from "@muha-sdk/core";
import { piAdapter } from "@muha-sdk/pi-adapter";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

// A model-provider boundary, not a mock of the Adapter or SDK.
export async function controlledPi(t, respond) {
  const root = await mkdtemp(join(tmpdir(), "muha-pi-controlled-"));
  const workspace = join(root, "workspace"), agentDir = join(root, "agent");
  await Promise.all([mkdir(workspace), mkdir(agentDir)]);
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    requests.push(payload);
    if (respond) return respond(payload, response, requests.length);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = { id: "controlled", object: "chat.completion.chunk", created: 1, model: "controlled",
      choices: [{ index: 0, delta: { role: "assistant", content: "Hello from Pi." }, finish_reason: null }] };
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    response.end(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { controlled: {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "controlled-only",
    models: ["controlled", "next", "minimal"].map(id => ({ id, name: id, reasoning: id !== "minimal", input: ["text", "image"],
      compat: { supportsReasoningEffort: true },
      contextWindow: 100000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
  } } }));
  const options = { env: { PI_CODING_AGENT_DIR: agentDir }, startupTimeoutMs: 10000, shutdownTimeoutMs: 2000 };
  let runtime;
  t.after(async () => {
    await runtime?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return { root, workspace, agentDir, requests, options,
    async runtime() {
      await runtime?.close();
      runtime = await createMuhaRuntime({ harnesses: [piAdapter(options)], dataDir: join(root, "diagnostics") });
      return runtime;
    },
  };
}

export async function completedTurn(session, text) {
  const turn = await session.startTurn([{ type: "text", text }]);
  const events = [];
  for await (const event of turn) events.push(event);
  return { result: await turn.result, events };
}

// Native fixtures run outside Muha with their own Pi environment, just as an
// external Pi consumer would. All session creation/parsing remains SDK-owned.
export async function nativePi(fixture, script, args = []) {
  const loader = new URL("../../dist/sdk-loader.mjs", import.meta.url).href;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e",
    `const { loadSdk } = await import(${JSON.stringify(loader)}); const sdk = await loadSdk();\n${script}`,
    fixture.workspace, ...args], { env: { ...process.env, PI_CODING_AGENT_DIR: fixture.agentDir }, timeout: 10000 });
  return JSON.parse(stdout);
}
