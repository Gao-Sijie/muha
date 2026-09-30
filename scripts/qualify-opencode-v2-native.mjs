// Local, project-only OpenCode v2 qualification. The default preflight uses no model tokens.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMuhaRuntime } from "@muha-sdk/core";
import { openCodeAdapter } from "@muha-sdk/opencode-adapter";

const QUESTION_PROMPTS = [
  "This is an interactive test. Call the built-in question tool exactly once now. Ask one single-select question with header 'Choice', question 'Which confirmation token should I return?', and two options labelled 'alpha' and 'beta'. Wait for the tool answer, then briefly confirm receipt. Do not answer the question yourself or use any other tool.",
  "Your next action must be a call to the built-in question tool, not plain assistant text. Ask exactly one single-select question: header 'Choice'; question 'Choose alpha or beta for this test'; options 'alpha' and 'beta'. Wait for the user's answer through the tool before replying. Do not use any other tool.",
];

const mode = process.argv[2] ?? "--preflight";
if (!["--preflight", "--text", "--image", "--tool", "--question"].includes(mode) || process.argv.length > 3) {
  process.stderr.write("Usage: node scripts/qualify-opencode-v2-native.mjs [--preflight|--text|--image|--tool|--question]\n");
  process.exitCode = 2;
} else {
  await qualify(mode);
}

async function qualify(mode) {
  const version = spawnSync("opencode", ["--version"], { encoding: "utf8", timeout: 30_000 });
  const evidence = {
    qualification: "opencode-v2-native",
    mode,
    model: "opencode-go/deepseek-v4.1-flash",
    binaryVersion: version.status === 0 ? version.stdout.trim() : "unavailable",
    route: "native",
    policy: mode === "--tool" || mode === "--question" ? "interactive" : "autoDeny",
    triggered: { text: false, image: false, tool: false, childSession: false,
      permission: false, form: false, interruption: false },
  };
  const root = await mkdtemp(join(tmpdir(), "muha-opencode-v2-real-"));
  let runtime;
  let created;
  let resumed;
  try {
    if (mode === "--question" && evidence.binaryVersion !== "opencode v2.0.11") {
      throw new Error("Question qualification requires the pinned opencode v2.0.11 binary");
    }
    if (mode === "--tool") await writeFile(join(root, "probe.txt"), "muha-tool-ok\n");
    runtime = await createMuhaRuntime({
      harnesses: [openCodeAdapter({ startupTimeoutMs: 30_000, shutdownTimeoutMs: 10_000 })],
      dataDir: join(root, "diagnostics"),
    });
    created = await runtime.createSession({ harness: "opencode", workspacePath: root,
      model: evidence.model, approvalPolicy: evidence.policy });
    evidence.sessionId = created.reference.sessionId;
    evidence.reference = created.reference;
    evidence.listed = (await runtime.listSessions({ harness: "opencode", workspacePath: root }))
      .some((entry) => entry.reference.sessionId === created.reference.sessionId);
    resumed = await runtime.resumeSession({ reference: created.reference, approvalPolicy: evidence.policy });
    evidence.resumedSameSession = resumed.reference.sessionId === created.reference.sessionId;
    if (mode === "--question") await qualifyQuestion(resumed, runtime, evidence);
    if (mode === "--text" || mode === "--image" || mode === "--tool") {
      const turn = await resumed.startTurn(mode === "--image"
        ? [{ type: "image", source: { type: "base64", mediaType: "image/png",
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" } },
          { type: "text", text: "Describe this image in one short sentence. Do not use tools." }]
        : [{ type: "text", text: mode === "--tool"
          ? "Use the read tool to read ./probe.txt once, then report what it contains. Do not guess or edit files."
          : "Reply with exactly muha-ok. Do not use tools." }]);
      const events = [];
      const interruptAtDeadline = setTimeout(() => { void turn.interrupt().catch(() => runtime.close()); }, 90_000);
      const closeAtDeadline = setTimeout(() => { void runtime.close(); }, 110_000);
      let result;
      try {
        for await (const event of turn) {
          events.push(event);
          if (event.type === "approval.requested") {
            await turn.respondToApproval(event.requestId, "deny");
          } else if (event.type === "question.requested") {
            await turn.respondToQuestion(event.requestId, { action: "dismiss" });
          }
        }
        result = await turn.result;
      } finally {
        clearTimeout(interruptAtDeadline);
        clearTimeout(closeAtDeadline);
      }
      evidence.triggered[mode === "--image" ? "image" : "text"] = true;
      evidence.turn = {
        status: result.status,
        finalTextSha256: typeof result.message?.text === "string"
          ? createHash("sha256").update(result.message.text).digest("hex") : null,
        finalTextNonempty: typeof result.message?.text === "string" && result.message.text.trim().length > 0,
        usage: result.usage ?? null,
        ...(result.status === "failed" ? { error: {
          code: result.error?.code ?? null,
          nativeCode: result.error?.nativeCode ?? null,
          operation: result.error?.operation ?? null,
          message: result.error?.message ?? null,
        } } : {}),
        eventTypes: events.map((event) => event.type),
        terminalCount: events.filter((event) => ["turn.completed", "turn.failed", "turn.interrupted"]
          .includes(event.type)).length,
      };
      evidence.triggered.tool = events.some((event) => event.type === "tool.started");
      evidence.triggered.permission = events.some((event) => event.type === "approval.requested");
      evidence.triggered.form = events.some((event) => event.type === "question.requested");
      evidence.triggered.childSession = events.some((event) => event.sessionId &&
        event.sessionId !== evidence.sessionId);
      if (result.status !== "completed") process.exitCode = 1;
    }
  } catch (error) {
    evidence.error = { code: error?.data?.code ?? error?.code ?? "UNKNOWN",
      operation: error?.data?.operation ?? null,
      message: error instanceof Error ? error.message : String(error) };
    process.exitCode = 1;
  } finally {
    try { await resumed?.close(); } catch { process.exitCode = 1; }
    try { await created?.close(); } catch { process.exitCode = 1; }
    try { await runtime?.close(); } catch { process.exitCode = 1; }
    await rm(root, { recursive: true, force: true });
    process.stdout.write(JSON.stringify(evidence) + "\n");
  }
}

async function qualifyQuestion(session, runtime, evidence) {
  evidence.questionAttempts = [];
  for (const [index, prompt] of QUESTION_PROMPTS.entries()) {
    const turn = await session.startTurn([{ type: "text", text: prompt }]);
    const events = [];
    let answerCommandAccepted = false;
    let unexpectedQuestionShape = false;
    let questionApprovalCount = 0;
    let otherApprovalDenialCount = 0;
    let deadlineExpired = false;
    const interruptAtDeadline = setTimeout(() => {
      deadlineExpired = true;
      void turn.interrupt().catch(() => runtime.close());
    }, 90_000);
    const closeAtDeadline = setTimeout(() => { void runtime.close(); }, 110_000);
    let result;
    try {
      for await (const event of turn) {
        events.push(event);
        if (event.type === "approval.requested") {
          const linkedTool = events.find((item) => item.type === "tool.started" &&
            item.toolCallId === event.toolCallId);
          const allowQuestion = event.details?.action === "question" &&
            linkedTool?.toolName === "question";
          await turn.respondToApproval(event.requestId, allowQuestion ? "allowOnce" : "deny");
          if (allowQuestion) questionApprovalCount++;
          else otherApprovalDenialCount++;
        } else if (event.type === "question.requested") {
          const field = event.questions.length === 1 ? event.questions[0] : undefined;
          if (events.filter((item) => item.type === "question.requested").length === 1 &&
              field?.input.kind === "select" && field.input.options.length > 0) {
            await turn.respondToQuestion(event.requestId, { action: "answer", answers: [{
              questionId: field.questionId, kind: "selection",
              optionIds: [field.input.options[0].optionId], customValues: [],
            }] });
            answerCommandAccepted = true;
          } else {
            unexpectedQuestionShape = true;
            await turn.respondToQuestion(event.requestId, { action: "dismiss" });
          }
        }
      }
      result = await turn.result;
    } finally {
      clearTimeout(interruptAtDeadline);
      clearTimeout(closeAtDeadline);
    }
    const questions = events.filter((event) => event.type === "question.requested");
    const resolutions = events.filter((event) => event.type === "question.resolved");
    const tools = events.filter((event) => event.type === "tool.started");
    const questionToolIdentityMatched = questions.length === 1 &&
      typeof questions[0].toolCallId === "string" &&
      tools.some((tool) => tool.toolCallId === questions[0].toolCallId);
    const questionToolStarted = tools.some((tool) => tool.toolName === "question");
    const questionApprovalObserved = events.some((event) => event.type === "approval.requested" &&
      event.details?.action === "question");
    const terminalCount = events.filter((event) => ["turn.completed", "turn.failed", "turn.interrupted"]
      .includes(event.type)).length;
    const attempt = {
      number: index + 1,
      status: result.status,
      usage: result.usage ?? null,
      eventTypes: events.map((event) => event.type),
      questionCount: questions.length,
      questionFieldKinds: questions.map((event) => event.questions.map((field) => field.input.kind)),
      questionToolIdentityMatched,
      questionToolStarted,
      questionApprovalObserved,
      answerCommandAccepted,
      unexpectedQuestionShape,
      questionApprovalCount,
      otherApprovalDenialCount,
      resolutions: resolutions.map((event) => ({ outcome: event.outcome, source: event.source })),
      terminalCount,
      deadlineExpired,
    };
    evidence.questionAttempts.push(attempt);
    evidence.triggered.text = true;
    evidence.triggered.tool ||= tools.length > 0;
    evidence.triggered.permission ||= questionApprovalCount + otherApprovalDenialCount > 0;
    evidence.triggered.form ||= questions.length > 0;
    evidence.triggered.childSession ||= events.some((event) => event.sessionId &&
      event.sessionId !== evidence.sessionId);
    if (questions.length > 0) {
      const passed = questions.length === 1 && !unexpectedQuestionShape && questionToolIdentityMatched &&
        answerCommandAccepted && resolutions.length === 1 && resolutions[0].requestId === questions[0].requestId &&
        resolutions[0].outcome === "answered" && resolutions[0].source === "caller" &&
        result.status === "completed" && terminalCount === 1;
      evidence.questionQualification = passed ? "PASS" : "TRIGGERED_BUT_FAILED";
      if (!passed) process.exitCode = 1;
      return;
    }
    if (result.status !== "completed" || deadlineExpired) {
      evidence.questionQualification = "FAILED_NO_QUESTION";
      process.exitCode = 1;
      return;
    }
  }
  evidence.questionQualification = "NOT_TRIGGERED";
  process.exitCode = 1;
}
