import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, delimiter } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createMuhaRuntime } from "@muha-sdk/core";
import { openCodeAdapter } from "@muha-sdk/opencode-adapter";
import { readV2Evidence } from "../support/v2-evidence.mjs";

const fakeBin = resolve(import.meta.dirname, "../fixtures/v2-harness-bin");

test("OpenCode v2 Runtime authenticates an owned serve before accepting Sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-v2-service-"));
  const evidenceFile = join(root, "evidence.json");
  let runtime;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [openCodeAdapter({
        env: {
          PATH: [fakeBin, dirname(process.execPath)].join(delimiter),
          MUHA_V2_EVIDENCE_FILE: evidenceFile,
        },
        startupTimeoutMs: 5_000,
        shutdownTimeoutMs: 5_000,
      })],
      dataDir: join(root, "diagnostics"),
    });
    assert.equal(runtime.status, "active");
    assert.equal(runtime.getHarnessCapabilities("opencode").sessionListing, true);
    const evidence = await readV2Evidence(evidenceFile,
      (snapshot) => snapshot.unauthenticated === 1 && snapshot.authenticated === 1);
    assert.equal(evidence.unauthenticated, 1);
    assert.equal(evidence.authenticated, 1);
    assert.deepEqual(evidence.requests, ["/api/info", "/api/info"]);
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode v2 preserves native Session identity and rejects another route before native action", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-v2-sessions-"));
  const workspace = join(root, "workspace");
  const evidenceFile = join(root, "evidence.json");
  await mkdir(workspace);
  let runtime;
  let created;
  let resumed;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [openCodeAdapter({
        env: {
          PATH: [fakeBin, dirname(process.execPath)].join(delimiter),
          MUHA_V2_EVIDENCE_FILE: evidenceFile,
        },
      })],
      dataDir: join(root, "diagnostics"),
    });
    created = await runtime.createSession({ harness: "opencode", workspacePath: workspace });
    assert.deepEqual(created.reference, {
      harness: "opencode",
      sessionId: "ses_v2_1",
      workspacePath: workspace,
      route: "native",
    });
    const listed = await runtime.listSessions({ harness: "opencode", workspacePath: workspace });
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0].reference, created.reference);
    resumed = await runtime.resumeSession({ reference: created.reference });
    assert.deepEqual(resumed.reference, created.reference);
    await assert.rejects(
      runtime.resumeSession({ reference: { ...created.reference, route: "combined" } }),
      (error) => error.data?.code === "UNSUPPORTED_ROUTE",
    );
    const evidence = await readV2Evidence(evidenceFile, (snapshot) => snapshot.created === 1);
    assert.equal(evidence.created, 1);
  } finally {
    await resumed?.close();
    await created?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode v2 text Turn exposes native output and one completed result", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-v2-turn-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  let runtime;
  let session;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [openCodeAdapter({
        env: { PATH: [fakeBin, dirname(process.execPath)].join(delimiter) },
      })],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({ harness: "opencode", workspacePath: workspace });
    const turn = await session.startTurn([{ type: "text", text: "hello" }]);
    const events = [];
    for await (const event of turn) events.push(event);
    const result = await turn.result;
    assert.equal(result.status, "completed");
    assert.equal(result.message.text, "OpenCode v2: hello");
    assert.equal(events.filter((event) => event.type === "turn.completed").length, 1);
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode v2 model and Effort selection reaches the same native Session", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-v2-model-"));
  const workspace = join(root, "workspace");
  const evidenceFile = join(root, "evidence.json");
  await mkdir(workspace);
  let runtime;
  let session;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [openCodeAdapter({
        env: {
          PATH: [fakeBin, dirname(process.execPath)].join(delimiter),
          MUHA_V2_EVIDENCE_FILE: evidenceFile,
        },
      })],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({
      harness: "opencode",
      workspacePath: workspace,
      model: "opencode-go/deepseek-v4.1-flash",
      effort: "high",
    });
    assert.equal(session.model, "opencode-go/deepseek-v4.1-flash");
    assert.equal(session.effort, "high");
    const turn = await session.startTurn([{ type: "text", text: "selected" }]);
    assert.equal((await turn.result).status, "completed");
    const evidence = await readV2Evidence(evidenceFile, (snapshot) => snapshot.prompts.length === 1);
    assert.deepEqual(evidence.prompts[0].model, {
      providerID: "opencode-go",
      id: "deepseek-v4.1-flash",
      variant: "high",
    });
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode v2 resumes a native-selected Variant without treating it as a new caller selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-v2-native-variant-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  let runtime;
  let created;
  let resumed;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [openCodeAdapter({ env: {
        PATH: [fakeBin, dirname(process.execPath)].join(delimiter),
        MUHA_V2_NATIVE_VARIANT: "native-default",
      } })], dataDir: join(root, "diagnostics"),
    });
    created = await runtime.createSession({ harness: "opencode", workspacePath: workspace,
      model: "opencode-go/deepseek-v4.1-flash" });
    resumed = await runtime.resumeSession({ reference: created.reference });
    assert.equal(resumed.effort, "native-default");
    await assert.rejects(runtime.resumeSession({ reference: created.reference,
      effort: "native-default" }), (error) => error.data?.nativeCode === "effort_not_supported");
  } finally {
    await resumed?.close();
    await created?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode v2 submits ordered mixed and image-only Turn input once with durable order metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-v2-image-"));
  const workspace = join(root, "workspace");
  const evidenceFile = join(root, "evidence.json");
  const pngPath = join(root, "pixel.png");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
  await mkdir(workspace);
  await writeFile(pngPath, png);
  let runtime;
  let session;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [openCodeAdapter({
        env: {
          PATH: [fakeBin, dirname(process.execPath)].join(delimiter),
          MUHA_V2_EVIDENCE_FILE: evidenceFile,
        },
      })],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({ harness: "opencode", workspacePath: workspace });
    const mixed = await session.startTurn([
      { type: "image", source: { type: "file", path: pngPath } },
      { type: "text", text: "before" },
      { type: "image", source: { type: "base64", mediaType: "image/jpeg", data: jpeg.toString("base64") } },
      { type: "text", text: "after" },
    ]);
    assert.equal((await mixed.result).status, "completed");
    const onlyImage = await session.startTurn([
      { type: "image", source: { type: "base64", mediaType: "image/png", data: png.toString("base64") } },
    ]);
    assert.equal((await onlyImage.result).status, "completed");
    const evidence = await readV2Evidence(evidenceFile, (snapshot) => snapshot.prompts.length === 2);
    assert.equal(evidence.prompts.length, 2);
    assert.equal(evidence.prompts[0].text, "beforeafter");
    assert.deepEqual(evidence.prompts[0].files, [
      { uri: `data:image/png;base64,${png.toString("base64")}`, name: "pixel.png" },
      { uri: `data:image/jpeg;base64,${jpeg.toString("base64")}` },
    ]);
    assert.deepEqual(evidence.prompts[0].metadata.muhaOrderedInput.parts.map((part) => part.type),
      ["image", "text", "image", "text"]);
    assert.equal(evidence.prompts[1].text, "");
    assert.deepEqual(evidence.prompts[1].metadata.muhaOrderedInput.parts.map((part) => part.type), ["image"]);
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode v2 rejects a missing ordered-input plugin before creating a native Session", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-v2-plugin-missing-"));
  const workspace = join(root, "workspace");
  const evidenceFile = join(root, "evidence.json");
  await mkdir(workspace);
  let runtime;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [openCodeAdapter({
        env: {
          PATH: [fakeBin, dirname(process.execPath)].join(delimiter),
          MUHA_V2_EVIDENCE_FILE: evidenceFile,
          MUHA_V2_PLUGIN_STATE: "missing",
        },
        // This case verifies missing-plugin rejection, not a subsecond process-start deadline.
        startupTimeoutMs: 2_000,
      })],
      dataDir: join(root, "diagnostics"),
    });
    await assert.rejects(runtime.createSession({ harness: "opencode", workspacePath: workspace }),
      (error) => error.data?.code === "HARNESS_ERROR");
    assert.equal((await readV2Evidence(evidenceFile,
      (snapshot) => snapshot.requests.includes("/api/plugin"))).created, 0);
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode v2 counts only this Turn's completed model steps and resets on next Turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-v2-usage-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  let runtime;
  let session;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [openCodeAdapter({ env: {
        PATH: [fakeBin, dirname(process.execPath)].join(delimiter), MUHA_V2_USAGE: "multi",
      } })],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({ harness: "opencode", workspacePath: workspace });
    for (const input of ["first", "second"]) {
      const turn = await session.startTurn([{ type: "text", text: input }]);
      const events = [];
      for await (const event of turn) events.push(event);
      const updates = events.filter((event) => event.type === "usage.updated").map((event) => event.usage);
      assert.deepEqual(updates, [
        { inputTokens: 4, outputTokens: 6, reasoningTokens: 0, cachedInputTokens: 0 },
        { inputTokens: 9, outputTokens: 13, reasoningTokens: 1, cachedInputTokens: 1 },
      ]);
      assert.deepEqual((await turn.result).usage, updates.at(-1));
    }
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode v2 pages the Message baseline without combining a cursor with order", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-v2-message-pages-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  let runtime;
  let session;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [openCodeAdapter({ env: {
        PATH: [fakeBin, dirname(process.execPath)].join(delimiter),
        MUHA_V2_MESSAGE_PAGES: "two",
      } })], dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({ harness: "opencode", workspacePath: workspace });
    for (const text of ["first", "second"]) {
      const turn = await session.startTurn([{ type: "text", text }]);
      assert.equal((await turn.result).status, "completed");
    }
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode v2 fails a Turn when authoritative step usage is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-v2-missing-usage-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  let runtime;
  let session;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [openCodeAdapter({ env: {
        PATH: [fakeBin, dirname(process.execPath)].join(delimiter), MUHA_V2_USAGE: "missing",
      } })],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({ harness: "opencode", workspacePath: workspace });
    const turn = await session.startTurn([{ type: "text", text: "failure" }]);
    assert.equal((await turn.result).status, "failed");
    assert.equal(session.status.status, "closed");
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode v2 preserves multiple Tool identities and progress in the public Turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-v2-tools-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  let runtime;
  let session;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [openCodeAdapter({ env: {
        PATH: [fakeBin, dirname(process.execPath)].join(delimiter),
        MUHA_V2_TOOL: "multi", MUHA_V2_USAGE: "multi",
      } })],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({ harness: "opencode", workspacePath: workspace });
    const turn = await session.startTurn([{ type: "text", text: "tools" }]);
    const events = [];
    for await (const event of turn) events.push(event);
    assert.equal((await turn.result).status, "completed");
    for (const kind of ["tool.started", "tool.updated", "tool.completed"]) {
      assert.equal(events.filter((event) => event.type === kind).length, 4, JSON.stringify(events));
    }
    const calls = events.filter((event) => event.type === "tool.started");
    assert.equal(new Set(calls.map((event) => event.toolCallId)).size, 4);
    assert.deepEqual(calls.map((event) => event.toolName), ["read", "shell", "read", "shell"]);
    assert.equal(events.filter((event) => event.type === "tool.completed").every((event) => !event.isError), true);
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode v2 preserves failed Tool output and rejects duplicate terminal events", async () => {
  for (const [variant, expected] of [["failure", "completed"], ["duplicate", "failed"]]) {
    const root = await mkdtemp(join(tmpdir(), "muha-opencode-v2-tool-terminal-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    let runtime;
    let session;
    try {
      runtime = await createMuhaRuntime({
        harnesses: [openCodeAdapter({ env: {
          PATH: [fakeBin, dirname(process.execPath)].join(delimiter), MUHA_V2_TOOL: variant,
        } })],
        dataDir: join(root, "diagnostics"),
      });
      session = await runtime.createSession({ harness: "opencode", workspacePath: workspace });
      const turn = await session.startTurn([{ type: "text", text: "tools" }]);
      const events = [];
      for await (const event of turn) events.push(event);
      assert.equal((await turn.result).status, expected, JSON.stringify(events));
      assert.equal(events.filter((event) => event.type === "tool.completed").length, 1);
      if (variant === "failure") {
        assert.equal(events.find((event) => event.type === "tool.completed").isError, true);
      } else {
        assert.equal(session.status.status, "closed");
      }
    } finally {
      await session?.close();
      await runtime?.close();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("OpenCode v2 Permission replies are one-time and retain their Tool identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-v2-permission-"));
  const workspace = join(root, "workspace");
  const evidenceFile = join(root, "evidence.json");
  await mkdir(workspace);
  let runtime;
  let session;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [openCodeAdapter({ env: {
        PATH: [fakeBin, dirname(process.execPath)].join(delimiter),
        MUHA_V2_PERMISSION: "ask", MUHA_V2_TOOL: "success", MUHA_V2_EVIDENCE_FILE: evidenceFile,
      } })],
      dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({ harness: "opencode", workspacePath: workspace,
      approvalPolicy: "interactive" });
    const turn = await session.startTurn([{ type: "text", text: "approval" }]);
    const events = [];
    for await (const event of turn) {
      events.push(event);
      if (event.type === "approval.requested") await turn.respondToApproval(event.requestId, "allowOnce");
    }
    assert.equal((await turn.result).status, "completed", JSON.stringify(events));
    const tool = events.find((event) => event.type === "tool.started");
    const request = events.find((event) => event.type === "approval.requested");
    assert.equal(request.toolCallId, tool.toolCallId);
    assert.equal(request.title, "OpenCode requests read permission");
    assert.equal(request.details.action, "read");
    assert.equal(events.filter((event) => event.type === "approval.resolved").length, 1);
    const evidence = await readV2Evidence(evidenceFile, (snapshot) => snapshot.permissions.length === 1);
    assert.equal(evidence.permissions.length, 1);
    assert.equal(evidence.permissions[0].decision, "once");
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode v2 auto policies select native rules and resolve residual requests once", async () => {
  for (const [policy, effect, decision] of [
    ["autoApprove", "allow", "once"], ["autoDeny", "deny", "reject"],
  ]) {
    const root = await mkdtemp(join(tmpdir(), "muha-opencode-v2-auto-policy-"));
    const workspace = join(root, "workspace");
    const evidenceFile = join(root, "evidence.json");
    await mkdir(workspace);
    let runtime;
    let session;
    try {
      runtime = await createMuhaRuntime({
        harnesses: [openCodeAdapter({ env: {
          PATH: [fakeBin, dirname(process.execPath)].join(delimiter),
          MUHA_V2_PERMISSION: "ask", MUHA_V2_EVIDENCE_FILE: evidenceFile,
        } })],
        dataDir: join(root, "diagnostics"),
      });
      session = await runtime.createSession({ harness: "opencode", workspacePath: workspace,
        approvalPolicy: policy });
      const turn = await session.startTurn([{ type: "text", text: "policy" }]);
      const events = [];
      for await (const event of turn) events.push(event);
      assert.equal((await turn.result).status, "completed", JSON.stringify(events));
      assert.equal(events.filter((event) => event.type === "approval.requested").length, 1);
      assert.equal(events.filter((event) => event.type === "approval.resolved").length, 1);
      const evidence = await readV2Evidence(evidenceFile, (snapshot) => snapshot.permissions.length === 1);
      assert.equal(evidence.permissions.length, 1);
      assert.equal(evidence.permissions[0].decision, decision);
      assert.deepEqual(evidence.createdPermissions[0],
        [{ action: "*", resource: "*", effect }]);
      assert.deepEqual(evidence.requests.filter((path) => path.includes("/permission/")),
        [`/api/session/ses_v2_1/permission/${evidence.permissions[0].requestID}/reply`]);
      assert.equal(evidence.created, 1);
      // The fake endpoint stores the rule in the native Session response.
      const listed = await runtime.listSessions({ harness: "opencode", workspacePath: workspace });
      assert.equal(listed.length, 1);
    } finally {
      await session?.close();
      await runtime?.close();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("OpenCode v2 Form maps options and custom multiselect answers to one Question", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-v2-form-"));
  const workspace = join(root, "workspace");
  const evidenceFile = join(root, "evidence.json");
  await mkdir(workspace);
  let runtime;
  let session;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [openCodeAdapter({ env: {
        PATH: [fakeBin, dirname(process.execPath)].join(delimiter),
        MUHA_V2_FORM: "multi", MUHA_V2_EVIDENCE_FILE: evidenceFile,
      } })], dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({ harness: "opencode", workspacePath: workspace });
    const turn = await session.startTurn([{ type: "text", text: "form" }]);
    const events = [];
    for await (const event of turn) {
      events.push(event);
      if (event.type !== "question.requested") continue;
      assert.equal(event.questions.length, 2);
      assert.equal(event.description, "Controlled form");
      assert.equal(event.questions[0].input.kind, "select");
      assert.equal(event.questions[1].input.kind, "multiselect");
      const [choice, tags] = event.questions;
      await turn.respondToQuestion(event.requestId, { action: "answer", answers: [
        { questionId: choice.questionId, kind: "selection", optionIds: [choice.input.options[1].optionId], customValues: [] },
        { questionId: tags.questionId, kind: "selection",
          optionIds: [tags.input.options[0].optionId], customValues: ["other"] },
      ] });
    }
    assert.equal((await turn.result).status, "completed", JSON.stringify(events));
    assert.equal(events.filter((event) => event.type === "question.resolved" && event.outcome === "answered").length, 1);
    assert.equal(events.filter((event) => event.type === "approval.requested").length, 0);
    const evidence = await readV2Evidence(evidenceFile, (snapshot) => snapshot.forms.length === 1);
    assert.deepEqual(evidence.forms[0].answer, { choice: "v-b", tags: ["tag-x", "other"] });
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode v2 native Form reply wins the Question race as a Harness answer", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-v2-native-form-reply-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  let runtime;
  let session;
  try {
    runtime = await createMuhaRuntime({ harnesses: [openCodeAdapter({ env: {
      PATH: [fakeBin, dirname(process.execPath)].join(delimiter), MUHA_V2_FORM: "native_reply",
    } })], dataDir: join(root, "diagnostics") });
    session = await runtime.createSession({ harness: "opencode", workspacePath: workspace });
    const turn = await session.startTurn([{ type: "text", text: "native answer" }]);
    const events = [];
    for await (const event of turn) events.push(event);
    assert.equal((await turn.result).status, "completed", JSON.stringify(events));
    const requested = events.find((event) => event.type === "question.requested");
    const resolved = events.filter((event) => event.type === "question.resolved");
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].source, "harness");
    assert.equal(resolved[0].outcome, "answered");
    assert.deepEqual(resolved[0].answers, [
      { questionId: requested.questions[0].questionId, kind: "selection",
        optionIds: [requested.questions[0].input.options[0].optionId], customValues: [] },
      { questionId: requested.questions[1].questionId, kind: "selection",
        optionIds: [requested.questions[1].input.options[1].optionId], customValues: [] },
    ]);
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode v2 native hidden-default reply does not expose its private value", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-v2-native-hidden-form-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  let runtime;
  let session;
  try {
    runtime = await createMuhaRuntime({ harnesses: [openCodeAdapter({ env: {
      PATH: [fakeBin, dirname(process.execPath)].join(delimiter), MUHA_V2_FORM: "native_reply_hidden",
    } })], dataDir: join(root, "diagnostics") });
    session = await runtime.createSession({ harness: "opencode", workspacePath: workspace });
    const turn = await session.startTurn([{ type: "text", text: "native hidden answer" }]);
    const events = [];
    for await (const event of turn) events.push(event);
    assert.equal((await turn.result).status, "completed", JSON.stringify(events));
    const requested = events.find((event) => event.type === "question.requested");
    const resolved = events.find((event) => event.type === "question.resolved");
    assert.equal(requested.questions[0].default.kind, "hidden");
    assert.deepEqual(requested.questions[1].when[0].comparison, { kind: "private" });
    assert.equal(resolved.source, "harness");
    assert.deepEqual(resolved.answers, [
      { questionId: requested.questions[0].questionId, kind: "useDefault" },
      { questionId: requested.questions[1].questionId, kind: "text", text: "yes" },
    ]);
    assert.equal(JSON.stringify(events).includes("token-private"), false);
    const diagnostics = new DatabaseSync(join(runtime.dataDir, "diagnostic-events.sqlite"), { readOnly: true });
    try {
      const payloads = diagnostics.prepare(
        "SELECT payload_json FROM native_event_records WHERE harness = 'opencode' ORDER BY record_id",
      ).all().map(({ payload_json }) => payload_json);
      assert.equal(payloads.some((payload) => payload.includes("token-private")), false);
    } finally { diagnostics.close(); }
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode v2 Form preserves typed fields, defaults, conditions, and external acknowledgement", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-v2-full-form-"));
  const workspace = join(root, "workspace");
  const evidenceFile = join(root, "evidence.json");
  await mkdir(workspace);
  let runtime;
  let session;
  try {
    runtime = await createMuhaRuntime({ harnesses: [openCodeAdapter({ env: {
      PATH: [fakeBin, dirname(process.execPath)].join(delimiter),
      MUHA_V2_FORM: "full", MUHA_V2_TOOL: "1", MUHA_V2_FORM_REJECT_ONCE: "1",
      MUHA_V2_EVIDENCE_FILE: evidenceFile,
    } })], dataDir: join(root, "diagnostics") });
    session = await runtime.createSession({ harness: "opencode", workspacePath: workspace });
    const turn = await session.startTurn([{ type: "text", text: "full form" }]);
    const events = [];
    for await (const event of turn) {
      events.push(event);
      if (event.type !== "question.requested") continue;
      assert.equal(event.description, "Complete the form");
      assert.equal(event.toolCallId, events.find((entry) => entry.type === "tool.started")?.toolCallId);
      assert.deepEqual(event.questions.map(({ input }) => input.kind), [
        "select", "number", "boolean", "text", "multiselect", "text", "number", "external",
      ]);
      assert.equal(event.questions[0].input.options[0].label, event.questions[0].input.options[1].label);
      assert.notEqual(event.questions[0].input.options[0].optionId, event.questions[0].input.options[1].optionId);
      assert.equal(event.questions[1].input.integer, true);
      assert.equal(event.questions[1].when[0].questionId, event.questions[0].questionId);
      assert.deepEqual(event.questions[1].when[0].comparison.optionIds,
        [event.questions[0].input.options[1].optionId]);
      assert.equal(event.questions[3].default.kind, "hidden");
      assert.deepEqual(event.questions[5].when[1].comparison, { kind: "private" });
      assert.equal(JSON.stringify(event).includes("token-private"), false);
      assert.equal(event.questions[5].input.format, "date");
      assert.equal(event.questions[7].input.url, "https://example.invalid/confirm");
      const [choice, count, toggle, secret, tags, date, amount, visit] = event.questions;
      const answers = [
        { questionId: choice.questionId, kind: "useDefault" },
        { questionId: count.questionId, kind: "useDefault" },
        { questionId: toggle.questionId, kind: "boolean", value: true },
        { questionId: secret.questionId, kind: "useDefault" },
        { questionId: tags.questionId, kind: "selection",
          optionIds: [tags.input.options[0].optionId], customValues: ["custom-1", "custom-2"] },
        { questionId: date.questionId, kind: "text", text: "2026-09-28" },
        { questionId: amount.questionId, kind: "useDefault" },
        { questionId: visit.questionId, kind: "externalAcknowledged" },
      ];
      await assert.rejects(turn.respondToQuestion(event.requestId, { action: "answer", answers: [
        ...answers.slice(0, 4), { questionId: tags.questionId, kind: "skipped" }, ...answers.slice(5),
      ] }), (error) => error.data?.code === "INVALID_INPUT");
      const rejectReplacement = async (index, replacement) => {
        const candidate = [...answers];
        candidate[index] = replacement;
        await assert.rejects(turn.respondToQuestion(event.requestId,
          { action: "answer", answers: candidate }), (error) => error.data?.code === "INVALID_INPUT");
      };
      await rejectReplacement(1, { questionId: count.questionId, kind: "number", value: 10 });
      await rejectReplacement(1, { questionId: count.questionId, kind: "number", value: 3.5 });
      await rejectReplacement(3, { questionId: secret.questionId, kind: "skipped" });
      await rejectReplacement(4, { questionId: tags.questionId, kind: "selection",
        optionIds: [tags.input.options[0].optionId], customValues: [] });
      await rejectReplacement(4, { questionId: tags.questionId, kind: "selection",
        optionIds: [tags.input.options[0].optionId], customValues: ["c1", "c2", "c3", "c4"] });
      await rejectReplacement(5, { questionId: date.questionId, kind: "text", text: "2026-02-30" });
      await rejectReplacement(6, { questionId: amount.questionId, kind: "number", value: 0.5 });
      await rejectReplacement(7, { questionId: visit.questionId, kind: "skipped" });
      const inactive = [...answers];
      inactive[0] = { questionId: choice.questionId, kind: "selection",
        optionIds: [choice.input.options[0].optionId], customValues: [] };
      await assert.rejects(turn.respondToQuestion(event.requestId,
        { action: "answer", answers: inactive }), (error) => error.data?.code === "INVALID_INPUT");
      await assert.rejects(turn.respondToQuestion(event.requestId,
        { action: "answer", answers }), (error) => error.data?.code === "HARNESS_ERROR");
      await turn.respondToQuestion(event.requestId, { action: "answer", answers });
    }
    assert.equal((await turn.result).status, "completed", JSON.stringify(events));
    assert.equal(events.filter((event) => event.type === "question.resolved").length, 1);
    const evidence = await readV2Evidence(evidenceFile, (snapshot) => snapshot.forms.length === 1);
    assert.deepEqual(evidence.forms[0].answer, {
      choice: "v-b", count: 3, toggle: true, secret: "token-private",
      tags: ["tag-x", "custom-1", "custom-2"], date: "2026-09-28", amount: 1.5, visit: true,
    });
    const diagnostics = new DatabaseSync(join(runtime.dataDir, "diagnostic-events.sqlite"), { readOnly: true });
    try {
      const payloads = diagnostics.prepare(
        "SELECT payload_json FROM native_event_records WHERE harness = 'opencode' ORDER BY record_id",
      ).all().map(({ payload_json }) => payload_json);
      assert.equal(payloads.some((payload) => payload.includes("token-private")), false);
      assert.equal(payloads.some((payload) => payload.includes('"type":"form.created"')), true);
      assert.equal(payloads.some((payload) => payload.includes('"type":"form.replied"')), true);
    } finally { diagnostics.close(); }
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode v2 Form preserves schema-valid empty keys, labels, and external URLs", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-v2-empty-form-"));
  const workspace = join(root, "workspace");
  const evidenceFile = join(root, "evidence.json");
  await mkdir(workspace);
  let runtime;
  let session;
  try {
    runtime = await createMuhaRuntime({ harnesses: [openCodeAdapter({ env: {
      PATH: [fakeBin, dirname(process.execPath)].join(delimiter),
      MUHA_V2_FORM: "empty", MUHA_V2_EVIDENCE_FILE: evidenceFile,
    } })], dataDir: join(root, "diagnostics") });
    session = await runtime.createSession({ harness: "opencode", workspacePath: workspace });
    const turn = await session.startTurn([{ type: "text", text: "empty strings" }]);
    for await (const event of turn) {
      if (event.type !== "question.requested") continue;
      const [choice, visit] = event.questions;
      assert.equal(choice.question, "Field 1");
      assert.equal(choice.input.options[0].label, "");
      assert.equal(visit.input.url, "");
      await turn.respondToQuestion(event.requestId, { action: "answer", answers: [
        { questionId: choice.questionId, kind: "selection", optionIds: [], customValues: [""] },
        { questionId: visit.questionId, kind: "externalAcknowledged" },
      ] });
    }
    assert.equal((await turn.result).status, "completed");
    const evidence = await readV2Evidence(evidenceFile, (snapshot) => snapshot.forms.length === 1);
    assert.deepEqual(evidence.forms[0].answer, { "": "", visit: true });
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode v2 Form enforces string formats, lengths, patterns, and neq conditions", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-v2-text-form-"));
  const workspace = join(root, "workspace");
  const evidenceFile = join(root, "evidence.json");
  await mkdir(workspace);
  let runtime;
  let session;
  try {
    runtime = await createMuhaRuntime({ harnesses: [openCodeAdapter({ env: {
      PATH: [fakeBin, dirname(process.execPath)].join(delimiter),
      MUHA_V2_FORM: "text_constraints", MUHA_V2_EVIDENCE_FILE: evidenceFile,
    } })], dataDir: join(root, "diagnostics") });
    session = await runtime.createSession({ harness: "opencode", workspacePath: workspace });
    const turn = await session.startTurn([{ type: "text", text: "text constraints" }]);
    for await (const event of turn) {
      if (event.type !== "question.requested") continue;
      const [email, link, timestamp, code, flag, after] = event.questions;
      assert.equal(email.input.format, "email");
      assert.equal(link.input.format, "uri");
      assert.equal(timestamp.input.format, "date-time");
      assert.equal(code.input.pattern, "^A[0-9]{2}$");
      assert.equal(code.input.placeholder, "A00");
      assert.equal(after.when[0].op, "neq");
      const answers = [
        { questionId: email.questionId, kind: "text", text: "a@example.com" },
        { questionId: link.questionId, kind: "text", text: "https://example.invalid" },
        { questionId: timestamp.questionId, kind: "text", text: "2026-09-28T12:00:00Z" },
        { questionId: code.questionId, kind: "text", text: "A12" },
        { questionId: flag.questionId, kind: "useDefault" },
        { questionId: after.questionId, kind: "text", text: "active" },
      ];
      const reject = async (index, replacement) => {
        const candidate = [...answers];
        candidate[index] = replacement;
        await assert.rejects(turn.respondToQuestion(event.requestId,
          { action: "answer", answers: candidate }), (error) => error.data?.code === "INVALID_INPUT");
      };
      await reject(0, { questionId: email.questionId, kind: "text", text: "not-email" });
      await reject(1, { questionId: link.questionId, kind: "text", text: "not a URI" });
      await reject(2, { questionId: timestamp.questionId, kind: "text", text: "not-a-date" });
      await reject(3, { questionId: code.questionId, kind: "text", text: "B12" });
      await reject(3, { questionId: code.questionId, kind: "text", text: "A1" });
      await reject(4, { questionId: flag.questionId, kind: "boolean", value: true });
      await turn.respondToQuestion(event.requestId, { action: "answer", answers });
    }
    assert.equal((await turn.result).status, "completed");
    const evidence = await readV2Evidence(evidenceFile, (snapshot) => snapshot.forms.length === 1);
    assert.deepEqual(evidence.forms[0].answer, {
      email: "a@example.com", link: "https://example.invalid",
      timestamp: "2026-09-28T12:00:00Z", code: "A12", flag: false, after: "active",
    });
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode v2 Form cancellation uses its native Form endpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-v2-form-cancel-"));
  const workspace = join(root, "workspace");
  const evidenceFile = join(root, "evidence.json");
  await mkdir(workspace);
  let runtime;
  let session;
  try {
    runtime = await createMuhaRuntime({
      harnesses: [openCodeAdapter({ env: {
        PATH: [fakeBin, dirname(process.execPath)].join(delimiter),
        MUHA_V2_FORM: "multi", MUHA_V2_EVIDENCE_FILE: evidenceFile,
      } })], dataDir: join(root, "diagnostics"),
    });
    session = await runtime.createSession({ harness: "opencode", workspacePath: workspace });
    const turn = await session.startTurn([{ type: "text", text: "cancel" }]);
    const events = [];
    for await (const event of turn) {
      events.push(event);
      if (event.type === "question.requested") {
        await turn.respondToQuestion(event.requestId, { action: "dismiss" });
      }
    }
    assert.equal((await turn.result).status, "completed", JSON.stringify(events));
    assert.equal(events.filter((event) => event.type === "question.resolved" && event.outcome === "dismissed").length, 1);
    const evidence = await readV2Evidence(evidenceFile,
      (snapshot) => snapshot.forms.some((form) => form.action === "dismiss"));
    assert.equal(evidence.forms[0].action, "dismiss");
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode v2 interrupt stops a pending Form and leaves one interrupted terminal", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-v2-interrupt-"));
  const workspace = join(root, "workspace");
  const evidenceFile = join(root, "evidence.json");
  await mkdir(workspace);
  let runtime;
  let session;
  try {
    runtime = await createMuhaRuntime({ harnesses: [openCodeAdapter({ env: {
      PATH: [fakeBin, dirname(process.execPath)].join(delimiter),
      MUHA_V2_FORM: "multi", MUHA_V2_EVIDENCE_FILE: evidenceFile,
    } })], dataDir: join(root, "diagnostics") });
    session = await runtime.createSession({ harness: "opencode", workspacePath: workspace });
    const turn = await session.startTurn([{ type: "text", text: "interrupt" }]);
    const events = [];
    for await (const event of turn) {
      events.push(event);
      if (event.type === "question.requested") await turn.interrupt();
    }
    assert.equal((await turn.result).status, "interrupted", JSON.stringify(events));
    assert.equal(events.filter((event) => ["turn.completed", "turn.failed", "turn.interrupted"]
      .includes(event.type)).length, 1);
    const evidence = await readV2Evidence(evidenceFile, (snapshot) => snapshot.interrupts.length === 1);
    assert.deepEqual(evidence.interrupts, [session.reference.sessionId]);
    assert.equal(evidence.forms.length, 0);
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode v2 attributes newly created child Session activity to the owning Turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-v2-child-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  let runtime;
  let session;
  try {
    runtime = await createMuhaRuntime({ harnesses: [openCodeAdapter({ env: {
      PATH: [fakeBin, dirname(process.execPath)].join(delimiter), MUHA_V2_CHILD: "active",
    } })], dataDir: join(root, "diagnostics") });
    session = await runtime.createSession({ harness: "opencode", workspacePath: workspace });
    const turn = await session.startTurn([{ type: "text", text: "child" }]);
    const events = [];
    for await (const event of turn) events.push(event);
    assert.equal((await turn.result).status, "completed", JSON.stringify(events));
    assert.ok(events.some((event) => event.type === "tool.started" && event.toolName === "child_read"));
    assert.ok(events.some((event) => event.type === "assistant.message.completed" && event.message.text === "Child output"));
    assert.deepEqual((await turn.result).usage,
      { inputTokens: 6, outputTokens: 9, reasoningTokens: 0, cachedInputTokens: 0 });
  } finally {
    await session?.close();
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});
