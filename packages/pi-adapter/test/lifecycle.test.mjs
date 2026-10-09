import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { controlledPi, completedTurn } from "./support/controlled-pi.mjs";
import { hasProcessStopped } from "./support/process-state.mjs";

test("Pi interrupts an accepted image/text request and can continue the same Session", { timeout: 15000 }, async t => {
  let requested;
  const firstRequest = new Promise(resolve => { requested = resolve; });
  const fixture = await controlledPi(t, (_payload, response, number) => {
    if (number === 1) { requested(); return; }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ id: "next", object: "chat.completion.chunk", created: 1, model: "controlled",
      choices: [{ index: 0, delta: { role: "assistant", content: "Continued." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  const runtime = await fixture.runtime();
  const session = await runtime.createSession({ harness: "pi", workspacePath: fixture.workspace,
    model: "controlled/controlled", approvalPolicy: "autoApprove" });
  const turn = await session.startTurn([{ type: "image", source: { type: "base64", mediaType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" } }, { type: "text", text: "Wait" }]);
  await firstRequest;
  await assert.rejects(session.startTurn([{ type: "text", text: "Concurrent" }]), error => error.data.code === "SESSION_BUSY");
  await turn.interrupt();
  assert.equal((await turn.result).status, "interrupted");
  assert.equal((await completedTurn(session, "Continue")).result.message.text, "Continued.");
});

test("losing one Pi SDK process fails its Turn and closes the whole Runtime", { timeout: 15000 }, async t => {
  let requested;
  const requestsStarted = new Promise(resolve => { requested = resolve; });
  const fixture = await controlledPi(t, (_payload, _response, number) => { if (number === 2) requested(); });
  await mkdir(join(fixture.agentDir, "extensions"));
  await writeFile(join(fixture.agentDir, "extensions", "identity.ts"), `
    import { writeFileSync } from "node:fs";
    import { join } from "node:path";
    export default pi => pi.on("session_start", (_event, ctx) => {
      writeFileSync(join(${JSON.stringify(fixture.root)}, ctx.sessionManager.getSessionId() + ".pid"), String(process.pid));
    });
  `);
  const runtime = await fixture.runtime();
  const options = { harness: "pi", workspacePath: fixture.workspace, model: "controlled/controlled", approvalPolicy: "autoApprove" };
  const first = await runtime.createSession(options);
  const second = await runtime.createSession(options);
  const firstTurn = await first.startTurn([{ type: "text", text: "First" }]);
  const secondTurn = await second.startTurn([{ type: "text", text: "Second" }]);
  await requestsStarted;
  process.kill(Number(await readFile(join(fixture.root, first.reference.sessionId + ".pid"), "utf8")), "SIGKILL");
  assert.equal((await firstTurn.result).status, "failed");
  assert.equal((await secondTurn.result).status, "interrupted");
  assert.notEqual(runtime.status, "active");
  await runtime.close();
  assert.equal(runtime.status, "closed");
});

test("Pi Session close reaps descendants even when the SDK process exits normally", { timeout: 15000 }, async t => {
  const fixture = await controlledPi(t);
  await mkdir(join(fixture.agentDir, "extensions"));
  const pidFile = join(fixture.root, "descendant.pid");
  await writeFile(join(fixture.agentDir, "extensions", "descendant.ts"), `
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    export default pi => pi.on("session_start", () => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      child.unref();
      writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
    });
  `);
  const runtime = await fixture.runtime();
  const session = await runtime.createSession({ harness: "pi", workspacePath: fixture.workspace,
    model: "controlled/controlled", approvalPolicy: "autoApprove" });
  const pid = Number(await readFile(pidFile, "utf8"));
  t.after(() => { try { process.kill(pid, "SIGKILL"); } catch {} });
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => unrelated.kill("SIGKILL"));
  await session.close();
  assert.doesNotThrow(() => process.kill(unrelated.pid, 0), "Closing Pi must leave unrelated host children alive");
  // Linux may retain a killed orphan briefly as a zombie until init reaps it.
  let stopped = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    stopped = await hasProcessStopped(pid);
    if (stopped) break;
    await delay(10);
  }
  assert.ok(stopped, "Owned descendant is still executing after Session.close");
});

for (const delayedSpawn of [false, true]) {
  test(`Pi fatal SDK loss reclaims an active native Bash tool's detached process group${delayedSpawn ? " before child identity can be reported" : ""}`, { timeout: 15000 }, async t => {
    const fixture = await controlledPi(t, (_request, response) => {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ id: "bash", object: "chat.completion.chunk", created: 1, model: "controlled",
        choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "bash-1", type: "function",
          function: { name: "bash", arguments: JSON.stringify({ command: "echo $$ > bash.pid; sleep 60" }) } }] },
        finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
    });
    if (delayedSpawn) {
      // Model a scheduler pause after the child exists but before the SDK regains
      // control. Reclamation must not depend on a post-spawn PID notification.
      const preload = join(fixture.root, "pause-after-spawn.mjs");
      await writeFile(preload, `
        import { ChildProcess } from "node:child_process";
        const spawn = ChildProcess.prototype.spawn;
        ChildProcess.prototype.spawn = function (options) {
          const result = Reflect.apply(spawn, this, [options]);
          if (options.detached && this.pid) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
          }
          return result;
        };
      `);
      fixture.options.env.NODE_OPTIONS = `--import=${pathToFileURL(preload).href}`;
    }
    await mkdir(join(fixture.agentDir, "extensions"));
    const sdkPidFile = join(fixture.root, "sdk.pid");
    await writeFile(join(fixture.agentDir, "extensions", "identity.ts"), `
      import { writeFileSync } from "node:fs";
      export default pi => pi.on("session_start", () => writeFileSync(${JSON.stringify(sdkPidFile)}, String(process.pid)));
    `);
    const runtime = await fixture.runtime();
    const session = await runtime.createSession({ harness: "pi", workspacePath: fixture.workspace,
      model: "controlled/controlled", approvalPolicy: "autoApprove" });
    const turn = await session.startTurn([{ type: "text", text: "Run the waiting tool" }]);
    let bashPid;
    for (let attempt = 0; attempt < 200 && !bashPid; attempt++) {
      try { bashPid = Number(await readFile(join(fixture.workspace, "bash.pid"), "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (!bashPid) await delay(10);
    }
    assert.ok(bashPid > 1, "Native Bash tool did not start");
    t.after(() => { try { process.kill(-bashPid, "SIGKILL"); } catch {} });
    process.kill(Number(await readFile(sdkPidFile, "utf8")), "SIGKILL");
    assert.equal((await turn.result).status, "failed");
    await runtime.close();
    let stopped = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      stopped = await hasProcessStopped(bashPid);
      if (stopped) break;
      await delay(10);
    }
    assert.ok(stopped, "Native detached Bash remains running after fatal Runtime close");
  });
}

test("losing a Pi worker during Session creation closes the Runtime and interrupts other Turns", { timeout: 10000 }, async t => {
  const fixture = await controlledPi(t, () => {});
  const runtime = await fixture.runtime();
  const options = { harness: "pi", workspacePath: fixture.workspace, model: "controlled/controlled", approvalPolicy: "autoApprove" };
  const session = await runtime.createSession(options);
  const turn = await session.startTurn([{ type: "text", text: "Wait while another Session starts" }]);
  await mkdir(join(fixture.agentDir, "extensions"));
  await writeFile(join(fixture.agentDir, "extensions", "exit.ts"), `
    export default pi => pi.on("session_start", () => process.exit(42));
  `);
  await assert.rejects(runtime.createSession(options), error => error.data.code === "RUNTIME_CLOSED");
  assert.equal((await turn.result).status, "interrupted");
  await runtime.close();
  assert.equal(runtime.status, "closed");
});

test("losing a short-lived Pi listing worker closes the active Runtime", { timeout: 10000 }, async t => {
  const fixture = await controlledPi(t, () => {});
  const preload = join(fixture.root, "startup.mjs"), flag = join(fixture.root, "fail-startup");
  await writeFile(preload, `import { existsSync } from "node:fs";
    if (existsSync(${JSON.stringify(flag)})) process.exit(42);`);
  fixture.options.env.NODE_OPTIONS = `--import=${pathToFileURL(preload).href}`;
  const runtime = await fixture.runtime();
  const session = await runtime.createSession({ harness: "pi", workspacePath: fixture.workspace,
    model: "controlled/controlled", approvalPolicy: "autoApprove" });
  const turn = await session.startTurn([{ type: "text", text: "Wait while listing" }]);
  await writeFile(flag, "ready");
  await assert.rejects(runtime.listSessions({ harness: "pi", workspacePath: fixture.workspace }), error => error.data.code === "RUNTIME_CLOSED");
  assert.equal((await turn.result).status, "interrupted");
  await runtime.close();
  assert.equal(runtime.status, "closed");
});

test("Pi initialization failure rolls back ownership and permits a fresh Runtime", async t => {
  const fixture = await controlledPi(t);
  fixture.options.env.NODE_OPTIONS = "--muha-invalid-node-option";
  await assert.rejects(fixture.runtime(), error => error.data.code === "RUNTIME_INITIALIZATION_FAILED");
  delete fixture.options.env.NODE_OPTIONS;
  const runtime = await fixture.runtime();
  assert.equal(runtime.status, "active");
  assert.deepEqual(await runtime.listSessions({ harness: "pi", workspacePath: fixture.workspace }), []);
});

test("Pi Registration snapshots environment overrides and deletions without changing the host", async t => {
  const fixture = await controlledPi(t);
  const original = process.env.MUHA_PI_ENV_FIXTURE;
  process.env.MUHA_PI_ENV_FIXTURE = "host";
  t.after(() => {
    if (original === undefined) delete process.env.MUHA_PI_ENV_FIXTURE;
    else process.env.MUHA_PI_ENV_FIXTURE = original;
  });
  const cwd = process.cwd();
  fixture.options.env.MUHA_PI_ENV_FIXTURE = undefined;
  fixture.options.env.MUHA_PI_CHILD_FIXTURE = "snapshot";
  await mkdir(join(fixture.agentDir, "extensions"));
  await writeFile(join(fixture.agentDir, "extensions", "environment.ts"), `
    export default pi => pi.on("input", event => ({ action: "transform",
      text: event.text + " env=" + (process.env.MUHA_PI_ENV_FIXTURE ?? "deleted") + ":" + process.env.MUHA_PI_CHILD_FIXTURE }));
  `);
  const runtime = await fixture.runtime();
  fixture.options.env.MUHA_PI_CHILD_FIXTURE = "changed-after-registration";
  const session = await runtime.createSession({ harness: "pi", workspacePath: fixture.workspace,
    model: "controlled/controlled", approvalPolicy: "autoApprove" });
  assert.equal((await completedTurn(session, "Inspect only fixture variables")).result.status, "completed");
  assert.ok(JSON.stringify(fixture.requests[0].messages).includes("env=deleted:snapshot"));
  assert.equal(process.env.MUHA_PI_ENV_FIXTURE, "host");
  assert.equal(process.cwd(), cwd);
});
