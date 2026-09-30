import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { controlledPi, completedTurn } from "./support/controlled-pi.mjs";

test("Pi does not answer unsupported extension UI and can continue after rejecting the request", async t => {
  const fixture = await controlledPi(t);
  const extensions = join(fixture.agentDir, "extensions");
  await mkdir(extensions);
  const answerFile = join(fixture.root, "answer.txt");
  await writeFile(join(extensions, "confirm.ts"), `
    import { writeFileSync } from "node:fs";
    export default pi => pi.on("input", async (event, ctx) => {
      if (event.text !== "Ask for UI") return;
      const answer = await ctx.ui.confirm("Native confirmation", "Allow?");
      writeFileSync(${JSON.stringify(answerFile)}, String(answer));
    });
  `);
  const runtime = await fixture.runtime();
  const session = await runtime.createSession({ harness: "pi", workspacePath: fixture.workspace,
    model: "controlled/controlled", approvalPolicy: "autoApprove" });
  let outcome;
  try {
    const turn = await session.startTurn([{ type: "text", text: "Ask for UI" }]);
    outcome = await turn.result;
  } catch (error) {
    outcome = { status: "failed", error: error.data };
  }
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.error.code, "HARNESS_ERROR");
  assert.match(outcome.error.message, /interaction|UI/i);
  await assert.rejects(readFile(answerFile, "utf8"), { code: "ENOENT" });
  assert.equal(fixture.requests.length, 0);
  assert.equal((await completedTurn(session, "No UI this time")).result.status, "completed");
});

test("Pi reload discovers extension-authorized configuration changes without changing its Muha capabilities", async t => {
  const fixture = await controlledPi(t);
  const directory = join(fixture.agentDir, "extensions");
  await mkdir(directory);
  const settingsPath = join(fixture.agentDir, "settings.json");
  const helperPath = join(fixture.agentDir, "installed-helper.ts");
  const helper = `export default pi => pi.on("input", (event, ctx) => ({ action: "transform", text: event.text + " reloaded fixture; hasUI=" + ctx.hasUI }));`;
  await writeFile(join(directory, "installer.ts"), `
    import { writeFileSync } from "node:fs";
    export default pi => pi.registerCommand("install-fixture", {
      handler: async (_args, ctx) => {
        writeFileSync(${JSON.stringify(helperPath)}, ${JSON.stringify(helper)});
        writeFileSync(${JSON.stringify(settingsPath)}, JSON.stringify({ extensions: [${JSON.stringify(helperPath)}], retry: { enabled: true } }));
        await ctx.reload();
      }
    });
  `);
  const runtime = await fixture.runtime();
  const before = runtime.getHarnessCapabilities("pi");
  const session = await runtime.createSession({ harness: "pi", workspacePath: fixture.workspace,
    model: "controlled/controlled", approvalPolicy: "autoApprove" });
  // A native command with no Assistant Message is not a completed Muha Turn.
  assert.equal((await completedTurn(session, "/install-fixture")).result.status, "failed");
  assert.equal((await completedTurn(session, "Continue after installation")).result.status, "completed");
  assert.ok(JSON.stringify(fixture.requests.at(-1).messages).includes("reloaded fixture; hasUI=false"));
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { extensions: [helperPath], retry: { enabled: true } });
  assert.deepEqual(runtime.getHarnessCapabilities("pi"), before);
  assert.equal(before.workspaceMcp, false);
});

test("Pi waits for a native extension command's model execution before settling its public Turn", async t => {
  const fixture = await controlledPi(t);
  await mkdir(join(fixture.agentDir, "extensions"));
  await writeFile(join(fixture.agentDir, "extensions", "command.ts"), `
    export default pi => {
      pi.registerCommand("native-message", { handler: async () => { pi.sendUserMessage("Native extension message"); } });
      pi.on("input", async event => {
        if (event.source === "extension") await new Promise(resolve => setTimeout(resolve, 50));
      });
    };
  `);
  const runtime = await fixture.runtime();
  const session = await runtime.createSession({ harness: "pi", workspacePath: fixture.workspace,
    model: "controlled/controlled", approvalPolicy: "autoApprove" });
  const { result, events } = await completedTurn(session, "/native-message");
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(result.message.text, "Hello from Pi.");
  assert.deepEqual(events.filter(event => /^turn\.(completed|failed|interrupted)$/.test(event.type)).map(event => event.type), ["turn.completed"]);
  const requestsBefore = fixture.requests.length;
  const interrupted = await session.startTurn([{ type: "text", text: "/native-message" }]);
  await interrupted.interrupt();
  assert.equal((await interrupted.result).status, "interrupted");
  assert.equal(fixture.requests.length, requestsBefore, "An interrupted extension preflight must not later start a model request");
  assert.equal((await completedTurn(session, "Continue")).result.status, "completed");
});

test("Pi closes the Runtime when an unsupported extension UI handler refuses to settle", { timeout: 10000 }, async t => {
  const fixture = await controlledPi(t);
  fixture.options.shutdownTimeoutMs = 200;
  await mkdir(join(fixture.agentDir, "extensions"));
  await writeFile(join(fixture.agentDir, "extensions", "unsettled.ts"), `
    export default pi => pi.on("input", async (_event, ctx) => {
      try { await ctx.ui.input("Unanswerable"); } catch {}
      await new Promise(() => {});
    });
  `);
  const runtime = await fixture.runtime();
  const session = await runtime.createSession({ harness: "pi", workspacePath: fixture.workspace,
    model: "controlled/controlled", approvalPolicy: "autoApprove" });
  // There is no accepted Turn Handle yet. Fatal Runtime shutdown cancels the
  // in-flight command through Core's existing command supervisor.
  await assert.rejects(session.startTurn([{ type: "text", text: "Unanswerable" }]), error => error.data.code === "RUNTIME_CLOSED");
  await runtime.close();
  assert.equal(runtime.status, "closed");
  assert.equal(fixture.requests.length, 0);
});

test("a native extension abort remains interrupted even after partial Assistant text", { timeout: 10000 }, async t => {
  const fixture = await controlledPi(t, (_request, response) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ id: "partial", object: "chat.completion.chunk", created: 1, model: "controlled",
      choices: [{ index: 0, delta: { role: "assistant", content: "Partial answer" }, finish_reason: null }] })}\n\n`);
  });
  await mkdir(join(fixture.agentDir, "extensions"));
  await writeFile(join(fixture.agentDir, "extensions", "native-abort.ts"), `
    export default pi => pi.on("message_update", (event, ctx) => {
      if (event.assistantMessageEvent.type === "text_delta") ctx.abort();
    });
  `);
  const runtime = await fixture.runtime();
  const session = await runtime.createSession({ harness: "pi", workspacePath: fixture.workspace,
    model: "controlled/controlled", approvalPolicy: "autoApprove" });
  const { result, events } = await completedTurn(session, "Native abort");
  assert.equal(result.status, "interrupted");
  assert.equal(result.reason, "harness");
  assert.equal(events.some(event => event.type === "turn.completed"), false);
});

test("Pi preserves native extension tool success and denial without Muha approvals or MCP management", async t => {
  const fixture = await controlledPi(t, (_request, response, number) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const tool = number <= 2;
    const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, id: `extension-${number}`, type: "function",
      function: { name: "native_echo", arguments: JSON.stringify({ value: number === 1 ? "allowed" : "denied" }) } }] }
      : { role: "assistant", content: "Continued after native denial." };
    response.end(`data: ${JSON.stringify({ id: `extension-${number}`, object: "chat.completion.chunk", created: 1, model: "controlled",
      choices: [{ index: 0, delta, finish_reason: tool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  const evidence = join(fixture.workspace, "native-tool.txt");
  await mkdir(join(fixture.agentDir, "extensions"));
  await writeFile(join(fixture.agentDir, "extensions", "native-tool.ts"), `
    import { appendFileSync } from "node:fs";
    export default pi => {
      pi.registerTool({ name: "native_echo", label: "Native echo", description: "Echo the supplied value",
        parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
        async execute(_id, args) {
          appendFileSync(${JSON.stringify(evidence)}, args.value + "\\n");
          return { content: [{ type: "text", text: args.value }], details: {} };
        } });
      pi.on("tool_call", event => {
        if (event.toolName === "native_echo" && event.input.value === "denied") return { block: true, reason: "native extension policy denied" };
      });
    };
  `);
  const runtime = await fixture.runtime();
  const session = await runtime.createSession({ harness: "pi", workspacePath: fixture.workspace,
    model: "controlled/controlled", approvalPolicy: "autoApprove" });
  const { result, events } = await completedTurn(session, "Execute native extension tools");
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.deepEqual(events.filter(event => event.type === "tool.completed").map(event => event.isError), [false, true]);
  assert.ok(JSON.stringify(fixture.requests.at(-1).messages).includes("native extension policy denied"));
  assert.equal(await readFile(evidence, "utf8"), "allowed\n");
  assert.equal(events.some(event => /^(approval|question)\./.test(event.type)), false);
  const configured = await runtime.configureWorkspace({ workspacePath: fixture.workspace,
    mcpServers: [{ name: "unmanaged", transport: "stdio", command: "not-invoked" }] });
  assert.equal(configured.attempts[0].status, "failed");
  assert.equal(configured.attempts[0].error.code, "UNSUPPORTED_CAPABILITY");
  assert.equal(runtime.getHarnessCapabilities("pi").workspaceMcp, false);
  await assert.rejects(readFile(join(fixture.workspace, ".pi", "settings.json")), { code: "ENOENT" });
});
