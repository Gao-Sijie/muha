import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";

import { createMuhaRuntime } from "@muha-sdk/core";
import { openCodeAdapter } from "@muha-sdk/opencode-adapter";
import { readV2Evidence } from "../support/v2-evidence.mjs";

const fakeBin = resolve(import.meta.dirname, "../fixtures/v2-harness-bin");

async function withV2Runtime(env, action) {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-v2-failure-"));
  const workspace = join(root, "workspace");
  const evidenceFile = join(root, "evidence.json");
  const pidFile = join(root, "opencode.pid");
  await mkdir(workspace);
  let runtime;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [openCodeAdapter({
        env: { PATH: [fakeBin, dirname(process.execPath)].join(delimiter),
          MUHA_V2_EVIDENCE_FILE: evidenceFile, MUHA_V2_PID_FILE: pidFile, ...env },
        startupTimeoutMs: 2_000,
        shutdownTimeoutMs: 2_000,
      })],
      dataDir: join(root, "diagnostics"),
    });
    await action({ runtime, workspace, evidenceFile, pidFile });
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
}

for (const retry of ["scheduled", "scheduled-twice"]) test(`OpenCode v2 preserves one public Message across a native pre-output provider retry (${retry})`, async () => {
  await withV2Runtime({ MUHA_V2_RETRY: retry }, async ({ runtime, workspace, evidenceFile }) => {
    const session = await runtime.createSession({ harness: "opencode", workspacePath: workspace });
    try {
      const turn = await session.startTurn([{ type: "text", text: "native retry" }]);
      const events = [];
      for await (const event of turn) events.push(event);
      const result = await turn.result;
      assert.equal(result.status, "completed", JSON.stringify(result));
      assert.equal(result.message.text, "OpenCode v2: native retry");
      assert.equal(events.filter(event => event.type === "assistant.message.started").length, 1);
      assert.equal(events.filter(event => event.type === "assistant.message.completed").length, 1);
      assert.equal(events.filter(event => event.type.startsWith("turn.") &&
        ["turn.completed", "turn.failed", "turn.interrupted"].includes(event.type)).length, 1);
      assert.equal(events.filter(event => event.type === "turn.retrying").length, 0);
      assert.equal((await readV2Evidence(evidenceFile, snapshot => snapshot.prompts.length === 1)).prompts.length, 1);
    } finally { await session.close(); }
  });
});

for (const [name, env] of [
  ["missing command", { PATH: "/tmp/muha-no-opencode-command" }],
  ["malformed readiness", { MUHA_V2_READY: "malformed" }],
  ["incompatible v1 version", { MUHA_V2_VERSION: "1.0.0" }],
]) {
  test(`OpenCode v2 initialization fails closed on ${name}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "muha-opencode-v2-init-failure-"));
    try {
      await assert.rejects(createMuhaRuntime({
        harnesses: [openCodeAdapter({
          env: { PATH: [fakeBin, dirname(process.execPath)].join(delimiter), ...env },
          startupTimeoutMs: 500,
          shutdownTimeoutMs: 500,
        })],
        dataDir: join(root, "diagnostics"),
      }), (error) => error.data?.code === "RUNTIME_INITIALIZATION_FAILED" &&
        error.data.initializationFailures?.[0]?.harness === "opencode");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("OpenCode v2 rejects a malformed native create response", async () => {
  await withV2Runtime({ MUHA_V2_CREATE_RESPONSE: "malformed" }, async ({ runtime, workspace, evidenceFile }) => {
    await assert.rejects(runtime.createSession({ harness: "opencode", workspacePath: workspace }),
      (error) => error.data?.code === "ADAPTER_PROTOCOL_ERROR");
    assert.equal((await readV2Evidence(evidenceFile, (snapshot) => snapshot.created === 1)).created, 1);
  });
});

test("OpenCode v2 rejects a native prompt before returning an accepted Turn", async () => {
  await withV2Runtime({ MUHA_V2_PROMPT_REJECT: "all" }, async ({ runtime, workspace, evidenceFile }) => {
    const session = await runtime.createSession({ harness: "opencode", workspacePath: workspace });
    try {
      await assert.rejects(session.startTurn([{ type: "text", text: "reject" }]),
        (error) => error.data?.code === "HARNESS_ERROR" && error.data.operation === "startTurn");
      const evidence = await readV2Evidence(evidenceFile,
        (snapshot) => snapshot.requests.includes("/api/session/ses_v2_1/prompt"));
      assert.equal(evidence.prompts.length, 0);
    } finally { await session.close(); }
  });
});

test("OpenCode v2 owned-service loss settles an active Form Turn and closes Runtime", async () => {
  await withV2Runtime({ MUHA_V2_FORM: "multi" }, async ({ runtime, workspace, pidFile }) => {
    const session = await runtime.createSession({ harness: "opencode", workspacePath: workspace });
    const turn = await session.startTurn([{ type: "text", text: "wait for form" }]);
    const iterator = turn[Symbol.asyncIterator]();
    for (;;) {
      const item = await iterator.next();
      assert.equal(item.done, false);
      if (item.value.type === "question.requested") break;
    }
    const pid = Number(await readFile(pidFile, "utf8"));
    assert.ok(Number.isSafeInteger(pid) && pid > 1);
    process.kill(pid, "SIGKILL");
    const events = [];
    for (;;) {
      const item = await iterator.next();
      if (item.done) break;
      events.push(item.value);
    }
    assert.equal((await turn.result).status, "failed", JSON.stringify(events));
    await runtime.close();
    assert.equal(runtime.status, "closed");
  });
});

test("OpenCode v2 reconnects an idle stream before the next Turn without replaying input", async () => {
  await withV2Runtime({ MUHA_V2_IDLE_DISCONNECT: "once" }, async ({ runtime, workspace, evidenceFile }) => {
    const session = await runtime.createSession({ harness: "opencode", workspacePath: workspace });
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      const turn = await session.startTurn([{ type: "text", text: "after idle disconnect" }]);
      assert.equal((await turn.result).status, "completed");
      const evidence = await readV2Evidence(evidenceFile,
        (snapshot) => snapshot.prompts.length === 1 &&
          snapshot.requests.filter((path) => path === "/api/event").length >= 2);
      assert.equal(evidence.prompts.length, 1);
      assert.ok(evidence.requests.filter((path) => path === "/api/event").length >= 2);
    } finally { await session.close(); }
  });
});

test("OpenCode v2 accepts a private durable-sequence skip when the visible Turn remains complete", async () => {
  await withV2Runtime({ MUHA_V2_STREAM: "private-gap" }, async ({ runtime, workspace }) => {
    const session = await runtime.createSession({ harness: "opencode", workspacePath: workspace });
    try {
      const turn = await session.startTurn([{ type: "text", text: "private event" }]);
      assert.equal((await turn.result).status, "completed");
    } finally { await session.close(); }
  });
});

for (const [name, env] of [
  ["blank final", { MUHA_V2_FINAL: "blank" }],
  ...["unmarked", "different-message", "invalid-attempt", "after-text", "after-reasoning", "after-tool", "missing-restart"]
    .map(retry => [`unsafe native retry: ${retry}`, { MUHA_V2_RETRY: retry }]),
  ["lost SSE stream", { MUHA_V2_STREAM: "disconnect" }],
  ["missing required step-start event", { MUHA_V2_STREAM: "gap" }],
  ["unknown Form field type", { MUHA_V2_FORM: "unsupported" }],
  ["malformed Form constraint", { MUHA_V2_FORM: "constraint" }],
  ["malformed Form message metadata", { MUHA_V2_FORM: "metadata" }],
  ["duplicate Form field key", { MUHA_V2_FORM: "duplicate" }],
]) {
  test(`OpenCode v2 fails the active Turn on ${name}`, async () => {
    await withV2Runtime(env, async ({ runtime, workspace }) => {
      const session = await runtime.createSession({ harness: "opencode", workspacePath: workspace });
      try {
        const turn = await session.startTurn([{ type: "text", text: "fault" }]);
        const events = [];
        for await (const event of turn) events.push(event);
        assert.equal((await turn.result).status, "failed", JSON.stringify(events));
        assert.equal(events.filter((event) => ["turn.completed", "turn.failed", "turn.interrupted"]
          .includes(event.type)).length, 1);
        assert.equal(session.status.status, "closed");
      } finally { await session.close(); }
    });
  });
}
