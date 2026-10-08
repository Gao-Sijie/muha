import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadSdk } from "../dist/sdk-loader.mjs";
import { controlledPi } from "./support/controlled-pi.mjs";
const { createAgentSession, SessionManager, SettingsManager, DefaultResourceLoader } = await loadSdk();

const model = {
  id: "controlled", name: "controlled", api: "openai-completions", provider: "controlled",
  baseUrl: "https://invalid.invalid", reasoning: false, input: ["text", "image"],
  contextWindow: 100000, maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" };

async function fixture({ extension, waitForAbort = false, configure } = {}) {
  const root = await mkdtemp(join(tmpdir(), "muha-pi-sdk-test-"));
  const cwd = join(root, "workspace"), agentDir = join(root, "agent"), sessionDir = join(root, "sessions");
  await Promise.all([cwd, agentDir, sessionDir].map(p => mkdir(p)));
  await configure?.(cwd, agentDir);
  const inputs = [], events = [];
  const modelRuntime = {
    hasConfiguredAuth: () => true, checkAuth: async () => ({ type: "api_key", key: "controlled-only" }),
    getAvailableSnapshot: () => [model], getModel: () => model, isUsingOAuth: () => false,
    streamSimple: (_model, context, options) => {
      inputs.push(structuredClone(context.messages));
      const message = {
          role: "assistant", content: [{ type: "text", text: "OK" }],
          api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
      return {
        async *[Symbol.asyncIterator]() {
          if (waitForAbort) {
            await new Promise(resolve => options.signal.addEventListener("abort", resolve, { once: true }));
            await new Promise(resolve => setTimeout(resolve, 30));
            message.stopReason = "aborted";
            yield { type: "error", reason: "aborted", error: message };
          } else yield { type: "done", reason: "stop", message };
        },
        async result() { return message; },
      };
    },
  };
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
    extensionFactories: extension ? [extension] : [] });
  if (extension || configure) await resourceLoader.reload();
  const manager = SessionManager.create(cwd, sessionDir);
  const { session } = await createAgentSession({ cwd, agentDir, model, modelRuntime,
    thinkingLevel: "off", settingsManager, resourceLoader, sessionManager: manager, tools: [] });
  session.subscribe(event => events.push(event.type));
  await session.bindExtensions({});
  return { session, inputs, events, manager, sessionDir,
    async close() { await session.abort(); session.dispose(); await rm(root, { recursive: true, force: true }); } };
}

test("high-level ordered input reaches the model and restores as a normal user message", async () => {
  const f = await fixture();
  try {
    const content = [image, { type: "text", text: "first" }, image, { type: "text", text: "last" }];
    await f.session.prompt(content);
    assert.deepEqual(f.inputs[0].find(m => m.role === "user").content, content);
    assert.deepEqual(f.events.filter(t => t === "agent_settled"), ["agent_settled"]);
    const restored = SessionManager.open(f.manager.getSessionFile(), f.sessionDir);
    assert.deepEqual(restored.buildSessionContext().messages.find(m => m.role === "user").content, content);
    assert.equal(f.session.isIdle, true);
  } finally { await f.close(); }
});

test("image-only input stays image-only and legacy text retains its native representation", async () => {
  const f = await fixture();
  try {
    await f.session.prompt([image]);
    assert.deepEqual(f.inputs[0].find(m => m.role === "user").content, [image]);
    await f.session.prompt("legacy", { images: [image] });
    assert.deepEqual(f.inputs[1].filter(m => m.role === "user").at(-1).content,
      [{ type: "text", text: "legacy" }, image]);
  } finally { await f.close(); }
});

test("native input hooks see the projection and may explicitly replace ordered content", async () => {
  const observed = [];
  const f = await fixture({ extension(pi) {
    pi.on("input", event => {
      observed.push({ text: event.text, images: event.images });
      return { action: "transform", text: "transformed", images: [image] };
    });
  } });
  try {
    await f.session.prompt([image, { type: "text", text: "first" }, { type: "text", text: "last" }]);
    assert.deepEqual(observed, [{ text: "first\nlast", images: [image] }]);
    assert.deepEqual(f.inputs[0].find(m => m.role === "user").content,
      [{ type: "text", text: "transformed" }, image]);
  } finally { await f.close(); }
});

test("an explicit transform with identical projection still replaces ordered input", async () => {
  const f = await fixture({ extension(pi) {
    // The native runner collapses an unchanged text AND image-array identity
    // to continue. A replacement array makes this an actual native transform.
    pi.on("input", event => ({ action: "transform", text: event.text, images: [...event.images] }));
  } });
  try {
    await f.session.prompt([image, { type: "text", text: "same" }]);
    assert.deepEqual(f.inputs[0].find(message => message.role === "user").content,
      [{ type: "text", text: "same" }, image]);
  } finally { await f.close(); }
});

test("native image omission hints replace invalid images before provider submission", async () => {
  const f = await fixture();
  try {
    await f.session.prompt([{ ...image, data: "R0lGODlh", mimeType: "image/gif" }]);
    const user = f.inputs[0].find(message => message.role === "user");
    assert.deepEqual(user.content.map(part => part.type), ["text"]);
    assert.match(user.content[0].text, /Image omitted/);
    assert.equal(f.session.isIdle, true);
  } finally { await f.close(); }
});

test("passthrough hooks retain ordered content and native handled input does not execute a model", async () => {
  const f = await fixture({ extension(pi) {
    pi.on("input", event => event.text === "handled" ? { action: "handled" } : { action: "continue" });
  } });
  try {
    const content = [image, { type: "text", text: "first" }, image, { type: "text", text: "last" }];
    await f.session.prompt(content);
    assert.deepEqual(f.inputs[0].find(message => message.role === "user").content, content);
    await f.session.prompt([{ type: "text", text: "handled" }, image]);
    assert.equal(f.inputs.length, 1);
    assert.equal(f.session.isIdle, true);
    await f.session.prompt([{ type: "text", text: "next" }]);
    assert.equal(f.inputs.length, 2);
  } finally { await f.close(); }
});

test("ordered input preserves native Skill and prompt-template expansion semantics", async () => {
  const f = await fixture({ async configure(cwd) {
    const skill = join(cwd, ".pi", "skills", "ordered"), prompts = join(cwd, ".pi", "prompts");
    await mkdir(skill, { recursive: true });
    await mkdir(prompts, { recursive: true });
    await writeFile(join(skill, "SKILL.md"), "---\nname: ordered\ndescription: Native ordered fixture\n---\nThe native skill instruction is APRICOT.\n");
    await writeFile(join(prompts, "ordered.md"), "Native template says $ARGUMENTS");
  } });
  try {
    for (const [prompt, expected] of [["/skill:ordered help", "The native skill instruction is APRICOT."], ["/ordered PLUM", "Native template says PLUM"]]) {
      await f.session.prompt([image, { type: "text", text: prompt }, image]);
      const user = f.inputs.at(-1).filter(message => message.role === "user").at(-1);
      assert.deepEqual(user.content.map(part => part.type), ["text", "image", "image"]);
      assert.ok(user.content[0].text.includes(expected));
      assert.deepEqual(user.content.slice(1), [image, image]);
      assert.equal(f.session.isIdle, true);
    }
  } finally { await f.close(); }
});

test("ordered high-level input stays busy until delayed cancellation really settles", async () => {
  const f = await fixture({ waitForAbort: true });
  try {
    let finished = false;
    const running = f.session.prompt([image]).finally(() => { finished = true; });
    while (f.inputs.length === 0) await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.session.isIdle, false);
    const abort = f.session.abort();
    assert.equal(finished, false);
    await abort;
    await running;
    assert.equal(finished, true);
    assert.equal(f.session.isIdle, true);
    assert.deepEqual(f.events.filter(t => t === "agent_settled"), ["agent_settled"]);
  } finally { await f.close(); }
});

test("a clean consumer installs the declared Pi SDK and uses the verified input patch without global Pi", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-pi-packed-test-"));
  const repo = fileURLToPath(new URL("../../../", import.meta.url));
  const run = (command, args, cwd, input) => {
    const result = spawnSync(command, args, { cwd, input, encoding: "utf8", timeout: 120000,
      env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" }, maxBuffer: 8 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr || result.stdout || String(result.error));
    return result.stdout;
  };
  try {
    const artifacts = [];
    for (const name of ["@muha-sdk/core", "@muha-sdk/pi-adapter"]) {
      const packed = JSON.parse(run("npm", ["pack", "--workspace", name, "--json", "--pack-destination", root], repo));
      artifacts.push(join(root, packed[0].filename));
    }
    run("npm", ["install", "--prefer-offline", "--ignore-scripts", "--no-audit", "--no-fund", ...artifacts], root);
    const installed = JSON.parse(run("npm", ["ls", "@earendil-works/pi-coding-agent", "--depth=1", "--json"], root));
    assert.equal(installed.dependencies["@muha-sdk/pi-adapter"].dependencies["@earendil-works/pi-coding-agent"].version, "1.0.4");
    const source = `import assert from "node:assert/strict";
      import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
      import { createServer } from "node:http";
      import { createMuhaRuntime } from "@muha-sdk/core";
      import { piAdapter } from "@muha-sdk/pi-adapter";
      import { tmpdir } from "node:os"; import { join } from "node:path";
      import { loadSdk } from "./node_modules/@muha-sdk/pi-adapter/dist/sdk-loader.mjs";
      const { createAgentSession, SessionManager, SettingsManager, DefaultResourceLoader } = await loadSdk();
      const model = ${JSON.stringify(model)}, image = ${JSON.stringify(image)};
      ${fixture.toString()}
      const f = await fixture();
      try { await f.session.prompt([image]); assert.deepEqual(f.inputs[0].find(m => m.role === "user").content, [image]); }
      finally { await f.close(); }
      ${controlledPi.toString()}
      let cleanup;
      const controlled = await controlledPi({ after(fn) { cleanup = fn; } });
      controlled.options.env.PATH = "";
      try {
        let runtime = await controlled.runtime();
        const session = await runtime.createSession({ harness: "pi", workspacePath: controlled.workspace,
          model: "controlled/controlled", approvalPolicy: "autoApprove" });
        const turn = await session.startTurn([{ type: "image", source: { type: "base64", mediaType: image.mimeType, data: image.data } },
          { type: "text", text: "Describe this image" }]);
        for await (const event of turn) {}
        assert.equal((await turn.result).status, "completed");
        assert.deepEqual(controlled.requests[0].messages.find(m => m.role === "user").content.map(p => p.type), ["image_url", "text"]);
        const reference = session.reference;
        runtime = await controlled.runtime();
        assert.deepEqual((await runtime.listSessions({ harness: "pi", workspacePath: controlled.workspace }))[0].reference, reference);
        const restored = await runtime.resumeSession({ reference, approvalPolicy: "autoApprove" });
        const continued = await restored.startTurn([{ type: "text", text: "Continue" }]);
        for await (const event of continued) {}
        assert.equal((await continued.result).status, "completed");
      } finally { await cleanup(); }`;
    run(process.execPath, ["--input-type=module"], root, source);
    await writeFile(join(root, "consumer.mts"), `
      import { createMuhaRuntime, type SessionReference } from "@muha-sdk/core";
      import { piAdapter, type OfficialAdapterOptions } from "@muha-sdk/pi-adapter";
      const options: OfficialAdapterOptions = { env: { PATH: undefined } };
      const runtime = await createMuhaRuntime({ harnesses: [piAdapter(options)] });
      const session = await runtime.createSession({ harness: "pi", workspacePath: "/project", approvalPolicy: "autoApprove" });
      const reference: SessionReference = session.reference;
      await runtime.resumeSession({ reference, approvalPolicy: "harnessManaged" });
      await runtime.close();
    `);
    run(process.execPath, [join(repo, "node_modules/typescript/bin/tsc"), "--noEmit", "--strict", "--target", "ES2022",
      "--module", "NodeNext", "--moduleResolution", "NodeNext", "consumer.mts"], root);
    await writeFile(join(root, "node_modules/@muha-sdk/pi-adapter/dist/ordered-agent-session.mjs"), "// damaged private patch\n");
    run(process.execPath, ["--input-type=module"], root, `
      import assert from "node:assert/strict";
      import { createMuhaRuntime } from "@muha-sdk/core";
      import { piAdapter } from "@muha-sdk/pi-adapter";
      await assert.rejects(createMuhaRuntime({ harnesses: [piAdapter()], dataDir: ${JSON.stringify(join(root, "bad-patch-diagnostics"))} }),
        error => error.data.code === "RUNTIME_INITIALIZATION_FAILED");
    `);
  } finally { await rm(root, { recursive: true, force: true }); }
});
