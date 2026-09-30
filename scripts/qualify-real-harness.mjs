import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { crc32, deflateSync } from "node:zlib";

import { createMuhaRuntime } from "@muha-sdk/core";
import {
  qualificationModelForMode,
  qualificationProfileFor,
  qualificationTurnRetryPolicy,
} from "./real-harness-profiles.mjs";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [requested, mode, ...extra] = process.argv.slice(2);
  const profile = qualificationProfileFor(requested);
  if (requested === undefined || requested === "all") {
    process.stderr.write("An explicit Harness (codex|opencode|kimi|agy|pi) is required; implicit all is forbidden.\n");
    process.exitCode = 2;
  } else if (!profile) {
    process.stderr.write(`Unknown Harness: ${requested}\n`);
    process.exitCode = 2;
  } else if (extra.length !== 0) {
    process.stderr.write("Unexpected qualification arguments.\n");
    process.exitCode = 2;
  } else if (!['--preprobe', '--full', '--image', '--interrupt', '--resume-interrupt', '--question', '--effort'].includes(mode)) {
    process.stderr.write("Choose a bounded mode: --preprobe, --full, --image, --interrupt, --resume-interrupt, --question, or --effort.\n");
    process.exitCode = 2;
  } else {
    const key = `MUHA_QUALIFY_${profile.harness.toUpperCase()}_MODEL`;
    const imageKey = `MUHA_QUALIFY_${profile.harness.toUpperCase()}_IMAGE_MODEL`;
    const model = process.env[key];
    const expectedModel = qualificationModelForMode(profile, mode);
    if (model !== expectedModel) {
      process.stderr.write(`${key} must equal ${expectedModel}; no model substitution is allowed.\n`);
      process.exitCode = 2;
    } else if (mode === "--full" && profile.qualificationImageModel !== undefined &&
        process.env[imageKey] !== profile.qualificationImageModel) {
      process.stderr.write(`${imageKey} must equal ${profile.qualificationImageModel}; the image Turn uses a separate model.\n`);
      process.exitCode = 2;
    } else if (mode === "--effort" && profile.qualificationEffort === null) {
      process.stdout.write(`${JSON.stringify({ qualified: effortNotApplicable(profile, model) }, null, 2)}\n`);
    } else if (profile.command !== undefined && !(await commandOnPath(profile.command))) {
      process.stderr.write(`Required Harness command not found on PATH: ${profile.command}\n`);
      process.exitCode = 2;
    } else {
      try {
        process.stdout.write(`${JSON.stringify({ qualified: await qualify(profile, { mode, model }) }, null, 2)}\n`);
      } catch (error) {
        process.stderr.write(`${JSON.stringify({ status: "FAIL", harness: profile.harness,
          code: error?.data?.code ?? error?.code ?? "UNKNOWN",
          operation: error?.data?.operation ?? null,
          stage: error?.data?.stage ?? null,
          nativeCode: error?.data?.nativeCode ?? null,
          exitCode: error?.data?.exitCode ?? null,
          failures: error?.data?.initializationFailures?.map((failure) => ({
            code: failure.code, harness: failure.harness, operation: failure.operation,
            stage: failure.stage, command: failure.command, exitCode: failure.exitCode,
          })) })}\n`);
        process.exitCode = 1;
      }
    }
  }
}

function effortNotApplicable(profile, model) {
  return {
    harness: profile.harness,
    model,
    mode: "--effort",
    status: "NOT_APPLICABLE",
    reason: "fixed-model-does-not-support-native-effort",
  };
}

export async function qualify(profile, { mode, model }) {
  if (mode === "--effort" && profile.qualificationEffort === null) {
    return effortNotApplicable(profile, model);
  }
  const { harness } = profile;
  const turnRetryPolicy = qualificationTurnRetryPolicy(profile);
  const retrySelection = turnRetryPolicy === undefined ? {} : { turnRetryPolicy };
  const revision = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", timeout: 10_000 });
  const dirty = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8", timeout: 10_000 });
  const version = profile.command === undefined ? undefined :
    spawnSync(profile.command, ["--version"], { encoding: "utf8", timeout: 30_000 });
  const root = await mkdtemp(join(tmpdir(), `muha-real-${harness}-`));
  const workspace = join(root, "workspace");
  const skillDirectory = join(workspace, "qualification-skills", "muha-qualification");
  const imagePath = join(workspace, "pixel.png");
  let runtime;
  let session;
  const terminate = () => { process.exitCode = 1; void runtime?.close(); };
  process.once("SIGTERM", terminate);
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    "---\nname: muha-qualification\ndescription: Temporary Muha V0.1 qualification fixture.\n---\n\nQualification fixture.\n",
  );
  await writeFile(
    imagePath,
    blueImage(),
  );

  try {
    runtime = await createMuhaRuntime({
      harnesses: [profile.registration()],
      dataDir: join(root, "diagnostics"),
    });
    const capabilities = runtime.getHarnessCapabilities(harness);
    const configuration = await runtime.configureWorkspace({
      workspacePath: workspace,
      harnesses: [harness],
      skills: [{ source: "./qualification-skills", skillNames: ["muha-qualification"] }],
      mcpServers: [{
        name: "muha-qualification",
        transport: "stdio",
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
      }],
    });
    assert.deepEqual(configuration.attempts.map(({ status }) => status), ["succeeded", capabilities.workspaceMcp ? "succeeded" : "failed"]);
    if (!capabilities.workspaceMcp) assert.equal(configuration.attempts[1].error.code, "UNSUPPORTED_CAPABILITY");

    session = await runtime.createSession({
      harness,
      workspacePath: workspace,
      approvalPolicy: mode === "--question" ? "interactive" : "autoApprove",
      ...retrySelection,
      ...(model === undefined ? {} : { model }),
      ...(mode === "--effort" ? { effort: profile.qualificationEffort } : {}),
    });
    assert.equal(session.model, model, "Session did not retain the selected qualification model");
    if (mode === "--image") {
      if (!capabilities.imageInput) {
        return { harness, model, mode, status: "NOT_APPLICABLE", reason: "static Profile does not declare image input" };
      }
      const observation = await qualifyImage(session, imagePath, harness);
      return { harness, model, mode, observation,
        sourceRevision: revision.status === 0 ? revision.stdout.trim() : null,
        sourceDirty: dirty.status === 0 ? dirty.stdout.trim().length > 0 : null,
        harnessVersion: version?.status === 0 ? version.stdout.trim() : null,
        checks: ["image-pixels", "no-image-tool-substitution"] };
    }
    if (mode === "--effort") {
      process.stderr.write(`${JSON.stringify({ stage: "effort", phase: "created", harness,
        selectedEffort: session.effort ?? null, expectedEffort: profile.qualificationEffort })}\n`);
      assert.equal(session.effort, profile.qualificationEffort);
      const first = await execute(session, [{ type: "text", text: "Reply EFFORT_OK only. Do not use tools." }]);
      assertCompleted(first, "Effort-selected Turn");
      assert.match(first.result.message.text, /EFFORT_OK/);
      const reference = session.reference;
      await session.close();
      await runtime.close();
      runtime = await createMuhaRuntime({ harnesses: [profile.registration()], dataDir: join(root, "diagnostics-resumed") });
      session = await runtime.resumeSession({ reference, approvalPolicy: "autoApprove",
        model, effort: profile.qualificationEffort, ...retrySelection });
      process.stderr.write(`${JSON.stringify({ stage: "effort", phase: "resumed", harness,
        selectedEffort: session.effort ?? null, expectedEffort: profile.qualificationEffort })}\n`);
      assert.deepEqual(session.reference, reference);
      assert.equal(session.effort, profile.qualificationEffort);
      const resumed = await execute(session, [{ type: "text", text: "Reply EFFORT_RESUMED only. Do not use tools." }]);
      assertCompleted(resumed, "Resumed Effort-selected Turn");
      assert.match(resumed.result.message.text, /EFFORT_RESUMED/);
      if (capabilities.model.selectionAt.includes("idleSession")) {
        await session.setModel(model);
        assert.equal(session.model, model);
      }
      let idleEffort;
      if (capabilities.effort.selectionAt.includes("idleSession")) {
        idleEffort = profile.qualificationIdleEffort;
        assert.equal(typeof idleEffort, "string", "fixed native idle effort must be explicitly specified");
        await session.setEffort(idleEffort);
        assert.equal(session.effort, idleEffort);
        const idle = await execute(session, [{ type: "text", text: "Reply EFFORT_IDLE only. Do not use tools." }]);
        assertCompleted(idle, "Idle Model/Effort-selected Turn");
        assert.match(idle.result.message.text, /EFFORT_IDLE/);
        await session.setEffort(profile.qualificationEffort);
        assert.equal(session.effort, profile.qualificationEffort);
      }
      return { harness, model, mode, effort: profile.qualificationEffort,
        idleEffort,
        modelObservation: capabilities.model.observation, effortObservation: capabilities.effort.observation,
        sourceRevision: revision.status === 0 ? revision.stdout.trim() : null,
        sourceDirty: dirty.status === 0 ? dirty.stdout.trim().length > 0 : null,
        harnessVersion: version?.status === 0 ? version.stdout.trim() : null,
        checks: ["effort-at-create", "effort-at-resume", "real-turn-with-selection",
          ...(idleEffort === undefined ? [] : ["model-at-idle", "effort-change-at-idle", "real-turn-with-idle-selection"])] };
    }
    if (mode === "--question") {
      if (!capabilities.turnQuestions) {
        return { harness, model, mode, status: "NOT_APPLICABLE", reason: "static Profile does not declare Questions" };
      }
      const question = await qualifyQuestion(session, harness);
      if (question.status !== "PASS") process.exitCode = 1;
      return { harness, model, mode, sourceRevision: revision.status === 0 ? revision.stdout.trim() : null,
        sourceDirty: dirty.status === 0 ? dirty.stdout.trim().length > 0 : null,
        harnessVersion: version?.status === 0 ? version.stdout.trim() : null,
        question };
    }
    if (mode === "--resume-interrupt") {
      assertCompleted(await execute(session, [{ type: "text", text: "Reply READY only. Do not use tools." }]),
        "before resume-interrupt");
      const reference = session.reference;
      await session.close();
      await runtime.close();
      runtime = await createMuhaRuntime({ harnesses: [profile.registration()], dataDir: join(root, "diagnostics-resumed") });
      session = await runtime.resumeSession({ reference, approvalPolicy: "autoApprove", model, ...retrySelection });
      assert.deepEqual(session.reference, reference);
      await qualifyInterrupt(session, harness);
      return { harness, model, mode, sourceRevision: revision.status === 0 ? revision.stdout.trim() : null,
        sourceDirty: dirty.status === 0 ? dirty.stdout.trim().length > 0 : null,
        harnessVersion: version?.status === 0 ? version.stdout.trim() : null,
        checks: ["new-runtime-reference-resume", "interrupt", "continue-after-interrupt"] };
    }
    if (mode === "--interrupt") {
      await qualifyInterrupt(session, harness);
      return { harness, model, mode, sourceRevision: revision.status === 0 ? revision.stdout.trim() : null,
        sourceDirty: dirty.status === 0 ? dirty.stdout.trim().length > 0 : null,
        harnessVersion: version?.status === 0 ? version.stdout.trim() : null,
        checks: ["interrupt", "continue-after-interrupt"] };
    }
    const nonce = `MUHA_${Date.now().toString(36).toUpperCase()}`;
    const first = await execute(session, [
      { type: "text", text: `Reply with exactly this identifier and nothing else: ${nonce}` },
    ]);
    assertCompleted(first, "first prompt");
    assert.match(first.result.message.text, new RegExp(nonce));
    assert.ok(first.events.some(({ type }) => type === "assistant.message.delta"));

    const second = await execute(session, [
      { type: "text", text: "Reply with the exact identifier from my immediately previous message." },
    ]);
    assertCompleted(second, "multi-Turn prompt");
    assert.match(second.result.message.text, new RegExp(nonce));

    if (mode === "--full") {
      const tool = await execute(session, [
        { type: "text", text: "Use the shell tool to run `printf MUHA_TOOL_OK`, then report the output." },
      ]);
      assertCompleted(tool, "Tool prompt");
      assert.ok(tool.events.some(({ type }) => type === "tool.started"));
      assert.ok(tool.events.some((event) => event.type === "tool.completed" && !event.isError),
        "Tool must complete successfully, not only emit a terminal event");
    }

    if (mode === "--full" && (harness === "pi" || harness === "agy")) {
      const written = await execute(session, [{ type: "text", text: `Use a tool to write exactly ${nonce} to native-proof.txt in the current directory, then reply briefly.` }]);
      assertCompleted(written, "native file write");
      assert.ok(written.events.some(event => event.type === "tool.completed" && !event.isError));
      assert.equal((await readFile(join(workspace, "native-proof.txt"), "utf8")).trim(), nonce);
    }

    if (mode === "--full" && harness === "codex") {
      await qualifyCodexWorkspaceWrite(session, workspace, "created");
    }

    if (mode === "--full" && capabilities.imageInput) {
      if (profile.qualificationImageModel === undefined) {
        await qualifyImage(session, imagePath, harness);
      } else {
        const imageSession = await runtime.createSession({
          harness, workspacePath: workspace, model: profile.qualificationImageModel,
          approvalPolicy: "autoApprove",
          ...retrySelection,
        });
        try {
          assert.equal(imageSession.model, profile.qualificationImageModel,
            "Image Session did not retain the selected qualification model");
          assert.notEqual(imageSession.reference.sessionId, session.reference.sessionId,
            "Image qualification must use a separate native Session");
          await qualifyImage(imageSession, imagePath, harness);
        } finally {
          await imageSession.close();
        }
      }
    } else if (mode === "--full") {
      await assert.rejects(session.startTurn([{ type: "image", source: { type: "file", path: imagePath } }]),
        error => error.data?.code === "UNSUPPORTED_CAPABILITY");
    }

    const reference = session.reference;
    assert.equal(reference.route, "native");
    if (mode === "--full" && capabilities.sessionListing) {
      const listed = await runtime.listSessions({ harness, workspacePath: workspace });
    assert.ok(listed.some(({ reference: candidate }) =>
      candidate.harness === reference.harness &&
      candidate.sessionId === reference.sessionId &&
      candidate.workspacePath === reference.workspacePath));
    } else if (mode === "--full") {
      await assert.rejects(runtime.listSessions({ harness, workspacePath: workspace }),
        error => error.data?.code === "UNSUPPORTED_CAPABILITY");
    }
    await session.close();
    await runtime.close();
    runtime = await createMuhaRuntime({ harnesses: [profile.registration()], dataDir: join(root, "diagnostics-resumed") });
    session = await runtime.resumeSession({ reference, approvalPolicy: "autoApprove",
      ...retrySelection,
      ...(model === undefined ? {} : { model }) });
    assert.deepEqual(session.reference, reference);
    assert.equal(session.model, model, "Resumed Session did not retain the selected qualification model");

    const restored = await execute(session, [{ type: "text", text: "Without tools, repeat the exact MUHA_ identifier from the beginning of this conversation." }]);
    assertCompleted(restored, "new Runtime history resume");
    assert.match(restored.result.message.text, new RegExp(nonce));

    if (mode === "--full" && harness === "codex") {
      await qualifyCodexWorkspaceWrite(session, workspace, "resumed");
    }

    if (mode === "--preprobe") return {
      harness, route: reference.route, model, modelObservation: capabilities.model.observation,
      sourceRevision: revision.status === 0 ? revision.stdout.trim() : null,
      sourceDirty: dirty.status === 0 ? dirty.stdout.trim().length > 0 : null,
      harnessVersion: version?.status === 0 ? version.stdout.trim() : null,
      mode, checks: ["text", "two-turn-context", "new-runtime-reference-resume"],
    };

    await qualifyInterrupt(session, harness);

    return {
      harness,
      runtimeId: runtime.runtimeId,
      ...(model === undefined ? {} : { model }),
      ...(profile.qualificationImageModel === undefined ? {} : { imageModel: profile.qualificationImageModel }),
      mode,
      maxRetriesPerTurn: turnRetryPolicy?.maxRetries ?? 0,
      sourceRevision: revision.status === 0 ? revision.stdout.trim() : null,
      sourceDirty: dirty.status === 0 ? dirty.stdout.trim().length > 0 : null,
      harnessVersion: version?.status === 0 ? version.stdout.trim() : null,
      checks: [
        capabilities.workspaceMcp ? "workspace-skill-mcp" : "workspace-skill-and-mcp-rejection",
        "prompt-streaming",
        "multi-turn-context",
        "tool-interaction",
        ...(harness === "codex" ? ["workspace-cli-write-create-resume"] : []),
        capabilities.imageInput ? "image" : "image-rejection",
        capabilities.sessionListing ? "list-resume" : "known-reference-resume-and-list-rejection",
        "interrupt",
        ...(harness === "pi" ? ["native-file-effect", "visual-color-ground-truth", "new-runtime-history-resume", "continue-after-interrupt"] : []),
        ...(harness === "agy" ? ["native-file-effect", "new-runtime-history-resume", "continue-after-interrupt"] : []),
      ],
    };
  } finally {
    process.removeListener("SIGTERM", terminate);
    await session?.close().catch(() => undefined);
    await runtime?.close().catch(() => undefined);
    if (process.env.MUHA_QUALIFY_RETAIN === "1") {
      process.stderr.write(`Qualification artifacts retained at ${root}\n`);
    } else {
      await rm(root, { recursive: true, force: true });
    }
  }
}

async function qualifyImage(session, imagePath, harness) {
  const image = await execute(session, imageQualificationInput(imagePath));
  assertCompleted(image, "image prompt");
  const answer = image.result.message.text;
  const observation = {
    recognizedColor: ["blue", "red", "green", "black", "white", "yellow", "gray", "grey", "purple", "orange", "pink"]
      .find((color) => new RegExp(`\\b${color}\\b`, "i").test(answer)) ?? "other",
    toolStarted: image.events.some((event) => event.type === "tool.started"),
    finalTextLength: answer.length,
    usage: image.result.usage ?? null,
  };
  process.stderr.write(`${JSON.stringify({ stage: "image-observation", harness, model: session.model, ...observation })}\n`);
  assert.equal(observation.recognizedColor, "blue", "Image answer did not identify blue pixels");
  assert.equal(observation.toolStarted, false, "Image Turn used a Tool despite the instruction");
  return observation;
}

export function imageQualificationInput(imagePath) {
  return [
    { type: "text", text: "Look at the attached image and identify its dominant pixel color." },
    { type: "image", source: { type: "file", path: imagePath } },
    { type: "text", text: "Reply with exactly one lowercase English color word selected from: red, blue, green, yellow, black, white, orange, purple, pink, gray, grey. No other text, punctuation, quotes, or Markdown. Do not call tools. Determine the color from the actual pixels, not the filename." },
  ];
}

async function qualifyInterrupt(session, harness) {
    process.stderr.write(`${JSON.stringify({ stage: "interrupt", phase: "start", harness })}\n`);
    const interruptTurn = await session.startTurn([
      { type: "text", text: "Use the shell tool to run `sleep 30`, then report completion." },
    ]);
    const interruptEvents = [];
    let interruptRequested = false;
    for await (const event of interruptTurn) {
      interruptEvents.push(event);
      if (event.type === "approval.requested") {
        await interruptTurn.respondToApproval(event.requestId, "allowOnce");
      }
      if (event.type === "question.requested") {
        await interruptTurn.respondToQuestion(event.requestId, { action: "dismiss" });
      }
      if (event.type === "tool.started" && !interruptRequested) {
        interruptRequested = true;
        await interruptTurn.interrupt();
      }
    }
    const interrupted = await interruptTurn.result;
    process.stderr.write(`${JSON.stringify({ stage: "interrupt", phase: "result", harness,
      status: interrupted.status, eventRuns: eventRuns(interruptEvents) })}\n`);
    assert.equal(
      interruptRequested,
      true,
      `the Harness never started the interrupt fixture tool: ${JSON.stringify({
        eventTypes: interruptEvents.map(({ type }) => type),
        result: interrupted,
      })}`,
    );
    assert.equal(interrupted.status, "interrupted");
    if (harness === "pi" || harness === "agy") {
      process.stderr.write(`${JSON.stringify({ stage: "interrupt", phase: "continue", harness })}\n`);
      const continued = await execute(session, [{ type: "text", text: "Reply with exactly CONTINUED. Do not call tools." }]);
      assertCompleted(continued, "continue after interrupt");
      assert.match(continued.result.message.text, /CONTINUED/);
    }
}

async function qualifyQuestion(session, harness) {
  const prompts = {
    codex: [
      "Call request_user_input now. Ask one single-select question with options alpha and beta; wait for the caller's structured answer before replying. Do not ask in plain text or use other tools.",
      "Your next action must be request_user_input with exactly one choice question: alpha or beta. Wait for the tool answer; do not choose for the caller.",
    ],
    kimi: [
      "Call AskUserQuestion now. Ask exactly one single-choice question with options alpha and beta, wait for the answer, then reply briefly. Do not ask in plain text or choose for me.",
      "Your next action must be the native AskUserQuestion tool, not plain text. Let me choose alpha or beta through that tool, then acknowledge the answer.",
    ],
    opencode: [
      "Call the built-in question tool now. Ask exactly one single-select question with options alpha and beta; wait for the tool answer, then acknowledge it. Do not answer it yourself or use other tools.",
      "Your next action must be the built-in question tool, not plain text. Ask me to choose alpha or beta, wait for the answer, then reply briefly.",
    ],
  }[harness];
  assert.ok(prompts, `${harness} has no declared Question qualification prompt`);
  const attempts = [];
  for (const prompt of prompts) {
    const turn = await session.startTurn([{ type: "text", text: prompt }]);
    const events = [];
    let answered = false;
    let invalidShape = false;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; void turn.interrupt(); }, 90_000);
    let result;
    try {
      for await (const event of turn) {
        events.push(event);
        if (event.type === "approval.requested") {
          const tool = events.find((entry) => entry.type === "tool.started" &&
            entry.toolCallId === event.toolCallId);
          const questionTool = ["question", "AskUserQuestion", "request_user_input"].includes(tool?.toolName) ||
            event.details?.action === "question";
          await turn.respondToApproval(event.requestId, questionTool ? "allowOnce" : "deny");
        } else if (event.type === "question.requested") {
          const field = event.questions.length === 1 ? event.questions[0] : undefined;
          if (field?.input.kind === "select" && field.input.options.length >= 2 && !answered) {
            await turn.respondToQuestion(event.requestId, { action: "answer", answers: [{
              questionId: field.questionId, kind: "selection",
              optionIds: [field.input.options[0].optionId], customValues: [],
            }] });
            answered = true;
          } else {
            invalidShape = true;
            await turn.respondToQuestion(event.requestId, { action: "dismiss" });
          }
        }
      }
      result = await turn.result;
    } finally {
      clearTimeout(timer);
    }
    const questions = events.filter((event) => event.type === "question.requested");
    const resolutions = events.filter((event) => event.type === "question.resolved");
    const terminalCount = events.filter((event) => /^turn\.(completed|failed|interrupted)$/.test(event.type)).length;
    const passed = !timedOut && !invalidShape && answered && questions.length === 1 &&
      resolutions.length === 1 && resolutions[0].requestId === questions[0].requestId &&
      resolutions[0].outcome === "answered" && resolutions[0].source === "caller" &&
      result.status === "completed" && terminalCount === 1;
    const attempt = { status: passed ? "PASS" : questions.length === 0 ? "NOT_TRIGGERED" : "FAIL",
      resultStatus: result.status, questionCount: questions.length,
      fieldKinds: questions.map((event) => event.questions.map((field) => field.input.kind)),
      answered, invalidShape, timedOut, terminalCount,
      usage: result.usage ?? null, eventRuns: eventRuns(events) };
    attempts.push(attempt);
    process.stderr.write(`${JSON.stringify({ stage: "question", harness, attempt: attempts.length, ...attempt })}\n`);
    if (passed || attempt.status === "FAIL" || timedOut) break;
  }
  return { status: attempts.at(-1)?.status ?? "NOT_TRIGGERED", attempts };
}

async function qualifyCodexWorkspaceWrite(session, workspace, phase) {
  const nonce = `${phase}-${Date.now().toString(36)}`;
  const targetName = `.muha-codex-workspace-write-${phase}.txt`;
  const temporaryName = `${targetName}.tmp`;
  const initialContents = `initial-${nonce}`;
  const finalContents = `final-${nonce}`;
  const script = [
    'const fs=require("node:fs")',
    `fs.writeFileSync("${targetName}","${initialContents}")`,
    `fs.writeFileSync("${temporaryName}","${finalContents}")`,
    `fs.renameSync("${temporaryName}","${targetName}")`,
  ].join(";");
  const command = `node -e '${script}'`;
  const execution = await execute(session, [{
    type: "text",
    text: [
      "Use the command execution shell tool, not apply_patch or any file-editing tool.",
      `Run exactly this one command from the current Workspace: ${command}`,
      "After it succeeds, reply briefly.",
    ].join("\n"),
  }]);
  assertCompleted(execution, `Codex Workspace CLI write after Session ${phase}`);
  assert.ok(
    execution.events.some((event) =>
      event.type === "tool.started" &&
      event.toolName === "commandExecution" &&
      typeof event.input === "object" &&
      event.input !== null &&
      typeof event.input.command === "string" &&
      event.input.command.includes(targetName) &&
      event.input.command.includes("renameSync")),
    `Codex did not execute the required ordinary CLI command after Session ${phase}`,
  );
  assert.equal(await readFile(join(workspace, targetName), "utf8"), finalContents);
  await assert.rejects(access(join(workspace, temporaryName)), { code: "ENOENT" });
}

async function execute(session, input) {
  const turn = await session.startTurn(input);
  const events = [];
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void turn.interrupt(); }, 90_000);
  try {
    for await (const event of turn) {
      events.push(event);
      if (event.type === "approval.requested") {
        await turn.respondToApproval(event.requestId, "allowOnce");
      }
      if (event.type === "question.requested") {
        await turn.respondToQuestion(event.requestId, { action: "dismiss" });
      }
    }
    assert.equal(timedOut, false, "real qualification Turn exceeded its 90-second budget");
    return { events, result: await turn.result };
  } finally {
    clearTimeout(timer);
  }
}

function assertCompleted(execution, stage) {
  assert.equal(
    execution.result.status,
    "completed",
    `${stage} failed: ${JSON.stringify({
      eventTypes: execution.events.map(({ type }) => type),
      status: execution.result.status,
      code: execution.result.error?.code,
    })}`,
  );
  assert.deepEqual(execution.events.filter(event => /^turn\.(completed|failed|interrupted)$/.test(event.type)).map(event => event.type), ["turn.completed"], `${stage}: terminal uniqueness`);
  process.stderr.write(`${JSON.stringify({ stage, status: "completed", turnId: execution.result.turnId,
    finalTextLength: execution.result.message.text.length,
    usage: execution.result.usage ?? null,
    eventRuns: eventRuns(execution.events) })}\n`);
}

function eventRuns(events) {
  const runs = [];
  for (const { type } of events) {
    const previous = runs.at(-1);
    if (previous?.type === type) previous.count++;
    else runs.push({ type, count: 1 });
  }
  return runs;
}

function blueImage() {
  const chunk = (type, bytes) => {
    const body = Buffer.concat([Buffer.from(type), bytes]);
    const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length); checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(384, 0); header.writeUInt32BE(384, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc(384 * (1 + 384 * 3));
  for (let row = 0; row < 384; row++) {
    for (let col = 0; col < 384; col++) pixels[row * 1153 + 1 + col * 3 + 2] = 255;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}

async function commandOnPath(command) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory.length === 0) continue;
    try {
      await access(join(directory, command), constants.X_OK);
      return true;
    } catch {
      // Continue through PATH entries.
    }
  }
  return false;
}
