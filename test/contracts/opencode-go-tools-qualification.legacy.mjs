// Historical v1 tool qualifier contract. Retained for archaeology; not v2 real-model evidence.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";

import {
  classify,
  observeTurn,
} from "../../scripts/qualify-opencode-go-tool-model.mjs";

const runner = new URL("../../scripts/qualify-opencode-go-tools.mjs", import.meta.url).pathname;
const fakeWorker = resolve(import.meta.dirname, "../fixtures/qualification-bin/opencode-go-tool-worker");
const fakeHarnessBin = resolve(import.meta.dirname, "../fixtures/harness-bin");
const fakeQualificationBin = resolve(import.meta.dirname, "../fixtures/qualification-bin");
const repositoryRoot = resolve(import.meta.dirname, "../..");

test("opencode-go tool qualification rejects an invalid explicit model without starting work", () => {
  const result = spawnSync(process.execPath, [runner, "other-provider/model"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    qualification: "opencode-go-tools",
    schemaVersion: 1,
    timeoutMs: 360_000,
    classification: "INCONCLUSIVE",
    category: "invalid_model",
    requestedModels: ["other-provider/model"],
    results: [],
  });
});

test("silent npm qualification entrypoint emits one JSON document on stdout", () => {
  const result = spawnSync("npm", [
    "run",
    "--silent",
    "qualify:opencode-go-tools",
    "--",
    "other-provider/model",
  ], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout.trimStart().startsWith("{"), true);
  assert.equal(result.stdout.trimEnd().endsWith("}"), true);
  assert.equal(JSON.parse(result.stdout).category, "invalid_model");
});

test("opencode-go tool qualification validates a real Turn through the fake OpenCode boundary", () => {
  const result = spawnSync(process.execPath, [runner, "opencode-go/fake-tool-model"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: [fakeHarnessBin, dirname(process.execPath)].join(delimiter),
      MUHA_FAKE_OPENCODE_SCENARIO: "reused-tool-call-id",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.classification, "PASS");
  assert.equal(report.results.length, 1);
  assert.deepEqual(
    {
      model: report.results[0].model,
      classification: report.results[0].classification,
      attempts: report.results[0].attempts,
      metrics: report.results[0].metrics,
    },
    {
      model: "opencode-go/fake-tool-model",
      classification: "PASS",
      attempts: 1,
      metrics: {
        assistantMessages: 2,
        toolStarts: 2,
        toolCompletions: 2,
        approvalRequests: 1,
        questions: 1,
        toolErrors: 0,
        taskTestsPassed: false,
        nativeCallIdReused: null,
        toolConcurrency: false,
      },
    },
  );
  assert.equal(Number.isSafeInteger(report.results[0].durationMs), true);
});

test("opencode-go tool qualification runs one explicit model and sanitizes worker output", () => {
  const result = spawnSync(process.execPath, [runner, "opencode-go/kimi-k3"], {
    encoding: "utf8",
    env: { ...process.env, MUHA_QUALIFY_OPENCODE_WORKER_PATH: fakeWorker },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "Qualifying opencode-go/kimi-k3\n");
  assert.deepEqual(JSON.parse(result.stdout), {
    qualification: "opencode-go-tools",
    schemaVersion: 1,
    timeoutMs: 360_000,
    classification: "PASS",
    requestedModels: ["opencode-go/kimi-k3"],
    results: [{
      model: "opencode-go/kimi-k3",
      classification: "PASS",
      attempts: 1,
      durationMs: 12,
      metrics: {
        assistantMessages: 3,
        toolStarts: 4,
        toolCompletions: 4,
        approvalRequests: 1,
        questions: 0,
        toolErrors: 1,
        taskTestsPassed: false,
        nativeCallIdReused: null,
        toolConcurrency: false,
      },
    }],
  });
  assert.equal(result.stdout.includes("sensitive"), false);
});

test("opencode-go tool qualification retries one retryable startTurn failure with fresh work", () => {
  const root = mkdtempSync(join(tmpdir(), "muha-qualification-retry-"));
  const stateFile = join(root, "attempts.txt");
  const pidFile = join(root, "pids.txt");
  try {
    const result = spawnSync(process.execPath, [runner, "opencode-go/kimi-k3"], {
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "test",
        MUHA_QUALIFY_OPENCODE_WORKER_PATH: fakeWorker,
        MUHA_QUALIFY_TEST_RETRY_DELAY_MS: "1",
        MUHA_FAKE_QUALIFICATION_SEQUENCE: "retryable,pass",
        MUHA_FAKE_QUALIFICATION_STATE_FILE: stateFile,
        MUHA_FAKE_QUALIFICATION_PID_FILE: pidFile,
      },
    });

    assert.equal(result.status, 0);
    assert.equal(readFileSync(stateFile, "utf8"), "2");
    const pids = readFileSync(pidFile, "utf8").trim().split("\n");
    assert.equal(pids.length, 2);
    assert.notEqual(pids[0], pids[1]);
    const report = JSON.parse(result.stdout);
    assert.equal(report.classification, "PASS");
    assert.deepEqual(
      {
        classification: report.results[0].classification,
        attempts: report.results[0].attempts,
        transientRecovered: report.results[0].transientRecovered,
      },
      { classification: "PASS", attempts: 2, transientRecovered: true },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("opencode-go tool qualification classifies a real worker adapter protocol failure", () => {
  const result = spawnSync(process.execPath, [runner, "opencode-go/fake-tool-model"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: [fakeHarnessBin, dirname(process.execPath)].join(delimiter),
      MUHA_FAKE_OPENCODE_SCENARIO: "completed-tool-update",
    },
  });

  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.classification, "FAIL");
  assert.equal(report.results[0].classification, "FAIL");
  assert.equal(report.results[0].category, "adapter_protocol_error");
});

test("qualification worker validator rejects unknown interactions and event/result mismatches", async () => {
  const unknownInteraction = await observeTurn(fakeTurn([
    { type: "assistant.message.started", messageId: "message-1" },
    { type: "approval.requested", requestId: "approval-1", toolCallId: "unknown-tool" },
    { type: "approval.resolved", requestId: "approval-1" },
    { type: "assistant.message.completed", message: { id: "message-1" } },
    { type: "turn.completed" },
  ], { status: "completed" }));
  assert.deepEqual(
    pickClassification(classify(unknownInteraction, 1)),
    { classification: "FAIL", category: "lifecycle_invalid" },
  );

  const resultMismatch = await observeTurn(fakeTurn([
    { type: "assistant.message.started", messageId: "message-1" },
    { type: "assistant.message.completed", message: { id: "message-1" } },
    { type: "turn.completed" },
  ], { status: "interrupted" }));
  assert.deepEqual(
    pickClassification(classify(resultMismatch, 1)),
    { classification: "FAIL", category: "event_result_mismatch" },
  );
});

test("qualification worker validator rejects events after a terminal event", async () => {
  const observation = await observeTurn(fakeTurn([
    { type: "assistant.message.started", messageId: "message-1" },
    { type: "assistant.message.completed", message: { id: "message-1" } },
    { type: "turn.completed" },
    { type: "approval.requested", requestId: "approval-1" },
    { type: "approval.resolved", requestId: "approval-1" },
  ], { status: "completed" }));
  assert.deepEqual(
    pickClassification(classify(observation, 1)),
    { classification: "FAIL", category: "lifecycle_invalid" },
  );
});

function fakeTurn(events, result) {
  return {
    async *[Symbol.asyncIterator]() {
      yield* events;
    },
    respondToApproval: async () => undefined,
    respondToQuestion: async () => undefined,
    result: Promise.resolve(result),
  };
}

function pickClassification(result) {
  return { classification: result.classification, category: result.category };
}

test("opencode-go tool qualification times out once without retrying", () => {
  const root = mkdtempSync(join(tmpdir(), "muha-qualification-timeout-"));
  const stateFile = join(root, "attempts.txt");
  try {
    const result = spawnSync(process.execPath, [runner, "opencode-go/kimi-k3"], {
      encoding: "utf8",
      timeout: 2_000,
      env: {
        ...process.env,
        NODE_ENV: "test",
        MUHA_QUALIFY_OPENCODE_WORKER_PATH: fakeWorker,
        MUHA_QUALIFY_TEST_ATTEMPT_TIMEOUT_MS: "20",
        MUHA_FAKE_QUALIFICATION_SEQUENCE: "hang",
        MUHA_FAKE_QUALIFICATION_STATE_FILE: stateFile,
      },
    });

    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.classification, "INCONCLUSIVE");
    assert.deepEqual(
      {
        category: report.results[0].category,
        attempts: report.results[0].attempts,
      },
      { category: "timeout", attempts: 1 },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("opencode-go tool qualification discovers, filters, sorts, and runs every local model", () => {
  const result = spawnSync(process.execPath, [runner], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: [fakeQualificationBin, dirname(process.execPath)].join(delimiter),
      MUHA_QUALIFY_OPENCODE_WORKER_PATH: fakeWorker,
      MUHA_FAKE_OPENCODE_MODELS: [
        "opencode-go/zeta",
        "other-provider/ignored",
        "opencode-go/alpha",
        "opencode-go/zeta",
        "",
      ].join("\n"),
    },
  });

  assert.equal(result.status, 0);
  assert.equal(
    result.stderr,
    "Qualifying opencode-go/alpha\nQualifying opencode-go/zeta\n",
  );
  const report = JSON.parse(result.stdout);
  assert.equal(report.classification, "PASS");
  assert.deepEqual(report.requestedModels, []);
  assert.deepEqual(report.results.map(({ model }) => model), [
    "opencode-go/alpha",
    "opencode-go/zeta",
  ]);
});

test("opencode-go tool qualification reports every model after fail and inconclusive outcomes", () => {
  const root = mkdtempSync(join(tmpdir(), "muha-qualification-matrix-"));
  const stateFile = join(root, "attempts.txt");
  try {
    const result = spawnSync(process.execPath, [
      runner,
      "opencode-go/pass",
      "opencode-go/fail",
      "opencode-go/inconclusive",
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        MUHA_QUALIFY_OPENCODE_WORKER_PATH: fakeWorker,
        MUHA_FAKE_QUALIFICATION_STATE_FILE: stateFile,
        MUHA_FAKE_QUALIFICATION_BY_MODEL: JSON.stringify({
          "opencode-go/pass": "pass",
          "opencode-go/fail": "fail",
          "opencode-go/inconclusive": "inconclusive",
        }),
      },
    });

    assert.equal(result.status, 1);
    assert.equal(readFileSync(stateFile, "utf8"), "3");
    const report = JSON.parse(result.stdout);
    assert.equal(report.classification, "FAIL");
    assert.deepEqual(
      report.results.map(({ model, classification }) => ({ model, classification })),
      [
        { model: "opencode-go/fail", classification: "FAIL" },
        { model: "opencode-go/inconclusive", classification: "INCONCLUSIVE" },
        { model: "opencode-go/pass", classification: "PASS" },
      ],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("opencode-go tool qualification does not retry non-retryable or protocol failures", () => {
  for (const [outcome, classification, category] of [
    ["nonretryable", "INCONCLUSIVE", "harness_error"],
    ["fail", "FAIL", "adapter_protocol_error"],
  ]) {
    const root = mkdtempSync(join(tmpdir(), `muha-qualification-${outcome}-`));
    const stateFile = join(root, "attempts.txt");
    try {
      const result = spawnSync(process.execPath, [runner, "opencode-go/kimi-k3"], {
        encoding: "utf8",
        env: {
          ...process.env,
          MUHA_QUALIFY_OPENCODE_WORKER_PATH: fakeWorker,
          MUHA_FAKE_QUALIFICATION_SEQUENCE: outcome,
          MUHA_FAKE_QUALIFICATION_STATE_FILE: stateFile,
        },
      });
      const report = JSON.parse(result.stdout);
      assert.equal(result.status, 1);
      assert.equal(readFileSync(stateFile, "utf8"), "1");
      assert.deepEqual(
        {
          classification: report.results[0].classification,
          category: report.results[0].category,
          attempts: report.results[0].attempts,
        },
        { classification, category, attempts: 1 },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("opencode-go tool qualification stops after two retryable failures", () => {
  const root = mkdtempSync(join(tmpdir(), "muha-qualification-persistent-transient-"));
  const stateFile = join(root, "attempts.txt");
  try {
    const result = spawnSync(process.execPath, [runner, "opencode-go/kimi-k3"], {
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "test",
        MUHA_QUALIFY_OPENCODE_WORKER_PATH: fakeWorker,
        MUHA_QUALIFY_TEST_RETRY_DELAY_MS: "1",
        MUHA_FAKE_QUALIFICATION_SEQUENCE: "retryable,retryable",
        MUHA_FAKE_QUALIFICATION_STATE_FILE: stateFile,
      },
    });
    const report = JSON.parse(result.stdout);
    assert.equal(result.status, 1);
    assert.equal(readFileSync(stateFile, "utf8"), "2");
    assert.deepEqual(
      {
        classification: report.results[0].classification,
        category: report.results[0].category,
        attempts: report.results[0].attempts,
        transientRecovered: report.results[0].transientRecovered,
      },
      {
        classification: "INCONCLUSIVE",
        category: "harness_error",
        attempts: 2,
        transientRecovered: undefined,
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
