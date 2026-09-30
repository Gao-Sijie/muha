import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { OpenCode } from "@opencode/client";

const pluginPath = resolve(import.meta.dirname, "../packages/opencode-adapter/dist/opencode-v2-order-plugin.js");
const workspace = await mkdtemp(join(tmpdir(), "muha-opencode-v2-plugin-"));
const configRoot = await mkdtemp(join(tmpdir(), "muha-opencode-v2-config-"));
await mkdir(join(configRoot, "plugins"));
await copyFile(pluginPath, join(configRoot, "plugins", "muha-order.js"));
let captureRequest;
let diagClient;
let diagSession;
const diagEvents = [];
const capturedRequest = new Promise((accept) => { captureRequest = accept; });
const imageRequests = [];
const provider = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  if (request.url === "/v1/chat/completions") {
    const value = JSON.parse(body);
    if (body.includes("image_url")) {
      imageRequests.push(value);
      captureRequest(value);
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({
      id: "chatcmpl-muha-probe", object: "chat.completion.chunk", created: 0, model: "image",
      choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
    })}\n\n`);
    response.write(`data: ${JSON.stringify({
      id: "chatcmpl-muha-probe", object: "chat.completion.chunk", created: 0, model: "image",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })}\n\n`);
    response.end("data: [DONE]\n\n");
  } else response.writeHead(404).end();
});
await new Promise((accept) => provider.listen(0, "127.0.0.1", accept));
const providerURL = `http://127.0.0.1:${provider.address().port}/v1`;
const password = "muha-plugin-probe-" + crypto.randomUUID();
const child = spawn("opencode", ["serve", "--stdio", "--port", "0"], {
  env: {
    ...process.env,
    OPENCODE_PASSWORD: password,
    OPENCODE_CONFIG_DIR: configRoot,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      model: "muha-probe/image",
      providers: {
        "muha-probe": {
          name: "Muha local probe",
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: providerURL, apiKey: "local-probe" },
          models: { image: {
            modelID: "image", name: "Image probe",
            capabilities: { tools: false, input: ["text", "image"], output: ["text"] },
            limit: { context: 32768, output: 4096 },
          }, text: {
            modelID: "text", name: "Text-only probe",
            capabilities: { tools: false, input: ["text"], output: ["text"] },
            limit: { context: 32768, output: 4096 },
          } },
        },
      },
    }),
  },
  stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (part) => { stderr += part.toString(); });
try {
  const lines = createInterface({ input: child.stdout });
  const ready = await Promise.race([
    new Promise((accept, reject) => {
      lines.once("line", (line) => {
        try { accept(JSON.parse(line)); }
        catch (error) { reject(error); }
      });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`OpenCode exited before readiness: ${code}`)));
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("OpenCode readiness timed out")), 15_000)),
  ]);
  const baseUrl = new URL(ready.url).origin;
  const authorization = "Basic " + Buffer.from("opencode:" + password).toString("base64");
  const client = OpenCode.make({ baseUrl, headers: { authorization } });
  diagClient = client;
  const diagnosticsAbort = new AbortController();
  void (async () => {
    try {
      for await (const event of client.event.subscribe({ signal: diagnosticsAbort.signal })) {
        diagEvents.push(event);
        if (diagEvents.length > 100) diagEvents.shift();
      }
    } catch { /* The controlled service may close during cleanup. */ }
  })();
  const info = await client.server.info();
  const config = await client.config.get({ location: { directory: workspace } });
  let plugins;
  let result;
  for (let attempt = 0; attempt < 20; attempt++) {
    plugins = await client.plugin.list({ location: { directory: workspace } });
    result = plugins.data.find((plugin) => plugin.id === "muha.ordered-input");
    if (result?.state.status === "active") break;
    await new Promise((accept) => setTimeout(accept, 250));
  }
  if (!result || result.state.status !== "active") {
    throw new Error(`Muha plugin not active: ${JSON.stringify({
      pluginConfig: config.map((entry) => ({ type: entry.type, path: entry.path, plugins: entry.info?.plugins })),
      plugins: plugins.data,
    })}`);
  }
  const session = await client.session.create({
    location: { directory: workspace },
    model: { providerID: "muha-probe", id: "image" },
  });
  diagSession = session.id;
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const sha256 = (value) => createHash("sha256").update(value).digest("hex");
  await client.session.prompt({
    sessionID: session.id,
    text: "AB",
    files: [{ uri: `data:image/png;base64,${png.toString("base64")}` }],
    metadata: { muhaOrderedInput: {
      version: 1, textSha256: sha256("AB"),
      parts: [{ type: "image", index: 0, mime: "image/png", sha256: sha256(png) },
        { type: "text", length: 2 }],
    } },
  });
  const request = await Promise.race([
    capturedRequest,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Local provider received no model request")), 20_000)),
  ]);
  const user = request.messages.findLast((item) => item.role === "user");
  if (!Array.isArray(user?.content)) {
    throw new Error(`Model request user content is not multipart: ${JSON.stringify(user)}`);
  }
  const partOrder = user.content.map((item) => item.type);
  if (JSON.stringify(partOrder) !== JSON.stringify(["image_url", "text"])) {
    throw new Error(`Model-facing order differs: ${JSON.stringify(partOrder)}`);
  }
  await client.session.wait({ sessionID: session.id });
  await client.session.prompt({ sessionID: session.id, text: "Next" });
  for (let attempt = 0; attempt < 80 && imageRequests.length < 2; attempt++) {
    await new Promise((accept) => setTimeout(accept, 100));
  }
  const replayed = imageRequests[1]?.messages.find((item) =>
    item.role === "user" && Array.isArray(item.content) && item.content.some((part) => part.type === "image_url"));
  if (JSON.stringify(replayed?.content.map((part) => part.type)) !== JSON.stringify(["image_url", "text"])) {
    throw new Error("Resumed model context did not preserve the earlier image order");
  }
  const rejected = await client.session.create({
    location: { directory: workspace }, model: { providerID: "muha-probe", id: "image" },
  });
  await client.session.prompt({
    sessionID: rejected.id,
    text: "X",
    files: [{ uri: `data:image/png;base64,${png.toString("base64")}` }],
    metadata: { muhaOrderedInput: {
      version: 1, textSha256: sha256("incorrect"),
      parts: [{ type: "text", length: 1 },
        { type: "image", index: 0, mime: "image/png", sha256: sha256(png) }],
    } },
  });
  await new Promise((accept) => setTimeout(accept, 1_000));
  if (imageRequests.length !== 2) throw new Error("Invalid order metadata was sent to the model");
  const textOnly = await client.session.create({
    location: { directory: workspace }, model: { providerID: "muha-probe", id: "text" },
  });
  const beforeTextOnly = imageRequests.length;
  await client.session.prompt({
    sessionID: textOnly.id, text: "X",
    files: [{ uri: `data:image/png;base64,${png.toString("base64")}` }],
    metadata: { muhaOrderedInput: { version: 1, textSha256: sha256("X"),
      parts: [{ type: "text", length: 1 },
        { type: "image", index: 0, mime: "image/png", sha256: sha256(png) }] } },
  });
  await new Promise((accept) => setTimeout(accept, 1_000));
  if (imageRequests.length !== beforeTextOnly || !diagEvents.some((event) =>
    event.type === "session.execution.failed" && event.data?.sessionID === textOnly.id &&
    /does not support images/.test(event.data.error?.message ?? ""))) {
    throw new Error("Text-only Model did not reject a Muha image before model dispatch");
  }
  await client.session.switchModel({ sessionID: session.id,
    model: { providerID: "muha-probe", id: "text" } });
  await client.session.prompt({ sessionID: session.id, text: "Revisit history" });
  await new Promise((accept) => setTimeout(accept, 1_000));
  if (imageRequests.length !== beforeTextOnly || !diagEvents.some((event) =>
    event.type === "session.execution.failed" && event.data?.sessionID === session.id &&
    /does not support images/.test(event.data.error?.message ?? ""))) {
    throw new Error("Text-only Model did not reject an ordered image in Session history");
  }
  console.log(JSON.stringify({ server: info.version, plugin: result.id,
    source: result.source.type, sourceMatches: result.source.path === join(configRoot, "plugins", "muha-order.js"),
    state: result.state.status, partOrder, replayed: true, invalidRejectedBeforeModel: true,
    unsupportedModelRejectedBeforeModel: true, historicalImageRejectedBeforeModel: true,
    eventSequence: diagEvents.filter((event) => event.data?.sessionID === session.id)
      .map((event) => ({ type: event.type, seq: event.durable?.seq })).slice(0, 60) }));
} catch (error) {
  console.error(error);
  if (diagClient && diagSession) {
    try { console.error(JSON.stringify(await diagClient.message.list({ sessionID: diagSession }))); }
    catch { /* Service may already be gone. */ }
  }
  console.error(JSON.stringify(diagEvents.filter((event) =>
    event.type === "session.execution.failed" || event.type === "session.step.failed")));
  if (stderr) console.error(stderr.slice(-4000));
  process.exitCode = 1;
} finally {
  child.stdin.end();
  await Promise.race([
    new Promise((accept) => child.once("exit", accept)),
    new Promise((accept) => setTimeout(() => { child.kill("SIGKILL"); accept(); }, 5_000)),
  ]);
  await rm(workspace, { recursive: true, force: true });
  await rm(configRoot, { recursive: true, force: true });
  await new Promise((accept) => provider.close(accept));
}
