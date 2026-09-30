import { spawn } from "node:child_process";
import { access } from "node:fs/promises";

import {
  emptyQualificationMetrics,
  isOpenCodeGoModel,
  qualificationTimeoutMs,
} from "./opencode-go-qualification-contract.mjs";

const qualification = "opencode-go-tools";
const schemaVersion = 1;
const timeoutMs = qualificationTimeoutMs;
const requestedModels = process.argv.slice(2);

if (requestedModels.some((model) => !isOpenCodeGoModel(model))) {
  report({
    classification: "INCONCLUSIVE",
    category: "invalid_model",
    requestedModels,
    results: [],
  });
  process.exitCode = 1;
} else {
  await main();
}

async function main() {
  let models;
  try {
    models = requestedModels.length > 0 ? uniqueSorted(requestedModels) : await discoverModels();
  } catch {
    report({
      classification: "INCONCLUSIVE",
      category: "model_discovery_failed",
      requestedModels,
      results: [],
    });
    process.exitCode = 1;
    return;
  }
  if (models.length === 0) {
    report({
      classification: "INCONCLUSIVE",
      category: "no_models",
      requestedModels,
      results: [],
    });
    process.exitCode = 1;
    return;
  }
  const results = [];
  for (const model of models) results.push(await qualifyModel(model));
  const classification = results.every(({ classification: value }) => value === "PASS")
    ? "PASS"
    : results.some(({ classification: value }) => value === "FAIL")
      ? "FAIL"
      : "INCONCLUSIVE";
  report({ classification, requestedModels, results });
  if (classification !== "PASS") process.exitCode = 1;
}

async function discoverModels() {
  const source = await runModelDiscovery();
  return uniqueSorted(source.split(/\r?\n/).map((model) => model.trim()).filter(isOpenCodeGoModel));
}

function runModelDiscovery() {
  return new Promise((resolve, reject) => {
    const child = spawn("opencode", ["models", "opencode-go", "--pure"], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 1_000_000) {
        child.kill("SIGKILL");
        finish(() => reject(new Error("model discovery output is too large")));
      }
    });
    child.stderr.resume();
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code, signal) => finish(() => {
      if (code === 0 && signal === null) resolve(stdout);
      else reject(new Error("model discovery failed"));
    }));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error("model discovery timed out")));
    }, 60_000);
    timer.unref();
  });
}

async function qualifyModel(model) {
  const workerPath = process.env.MUHA_QUALIFY_OPENCODE_WORKER_PATH ??
    new URL("./qualify-opencode-go-tool-model.mjs", import.meta.url).pathname;
  try {
    await access(workerPath);
  } catch {
    return inconclusive(model, "worker_unavailable");
  }
  process.stderr.write(`Qualifying ${model}\n`);
  const first = await runWorker(workerPath, model);
  if (!isRetryableStartTurnFailure(first)) return { model, ...first, attempts: 1 };
  process.stderr.write(`Retrying ${model} after transient startTurn failure\n`);
  await sleep(retryDelayMs());
  const second = await runWorker(workerPath, model);
  return {
    model,
    ...second,
    durationMs: (first.durationMs ?? 0) + (second.durationMs ?? 0),
    attempts: 2,
    ...(second.classification === "PASS" ? { transientRecovered: true } : {}),
  };
}

function runWorker(workerPath, model) {
  return new Promise((resolve) => {
    const workerTimeoutMs = attemptTimeoutMs();
    const child = spawn(process.execPath, [workerPath, model], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let forceTimer;
    let timedOut = false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      resolve(result);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.resume();
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      forceTimer.unref();
    }, workerTimeoutMs);
    timer.unref();
    child.once("error", () => {
      finish({
        classification: "FAIL",
        category: "worker_abnormal_exit",
        durationMs: 0,
        metrics: emptyQualificationMetrics(),
      });
    });
    child.once("exit", (code, signal) => {
      if (timedOut) {
        finish({
          classification: "INCONCLUSIVE",
          category: "timeout",
          durationMs: workerTimeoutMs,
          metrics: emptyQualificationMetrics(),
        });
        return;
      }
      if (code !== 0 || signal !== null) {
        finish({
          classification: "FAIL",
          category: "worker_abnormal_exit",
          durationMs: 0,
          metrics: emptyQualificationMetrics(),
        });
        return;
      }
      try {
        finish(validateWorkerResult(JSON.parse(stdout)));
      } catch {
        finish({
          classification: "FAIL",
          category: "worker_invalid_output",
          durationMs: 0,
          metrics: emptyQualificationMetrics(),
        });
      }
    });
  });
}

function validateWorkerResult(value) {
  if (!value || typeof value !== "object") throw new Error("invalid worker result");
  if (!["PASS", "FAIL", "INCONCLUSIVE"].includes(value.classification)) {
    throw new Error("invalid worker classification");
  }
  const durationMs = requireNonNegativeInteger(value.durationMs, "worker duration");
  const metrics = validateMetrics(value.metrics);
  const category = value.category === undefined ? undefined : sanitizeCategory(value.category);
  const failure = sanitizeFailure(value.failure);
  return {
    classification: value.classification,
    ...(category === undefined ? {} : { category }),
    durationMs,
    metrics,
    ...(failure === undefined ? {} : { failure }),
  };
}

function inconclusive(model, category) {
  return {
    model,
    classification: "INCONCLUSIVE",
    category,
    attempts: 0,
    durationMs: 0,
    metrics: emptyQualificationMetrics(),
  };
}

function isRetryableStartTurnFailure(result) {
  return result.classification === "INCONCLUSIVE" &&
    result.failure?.code === "HARNESS_ERROR" &&
    result.failure.operation === "startTurn" &&
    result.failure.retryable === true;
}

function retryDelayMs() {
  if (process.env.NODE_ENV !== "test") return 5_000;
  const value = Number(process.env.MUHA_QUALIFY_TEST_RETRY_DELAY_MS ?? "5000");
  return Number.isSafeInteger(value) && value >= 0 ? value : 5_000;
}

function attemptTimeoutMs() {
  if (process.env.NODE_ENV !== "test") return timeoutMs;
  const value = Number(process.env.MUHA_QUALIFY_TEST_ATTEMPT_TIMEOUT_MS ?? String(timeoutMs));
  return Number.isSafeInteger(value) && value > 0 ? value : timeoutMs;
}

function sleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function validateMetrics(value) {
  if (!value || typeof value !== "object") throw new Error("invalid worker metrics");
  return {
    assistantMessages: requireNonNegativeInteger(value.assistantMessages, "Assistant Message count"),
    toolStarts: requireNonNegativeInteger(value.toolStarts, "Tool start count"),
    toolCompletions: requireNonNegativeInteger(value.toolCompletions, "Tool completion count"),
    approvalRequests: requireNonNegativeInteger(value.approvalRequests, "Approval Request count"),
    questions: requireNonNegativeInteger(value.questions, "Question count"),
    toolErrors: requireNonNegativeInteger(value.toolErrors, "Tool error count"),
    taskTestsPassed: requireBooleanOrNull(value.taskTestsPassed, "task test result"),
    nativeCallIdReused: requireBooleanOrNull(value.nativeCallIdReused, "native Call id reuse"),
    toolConcurrency: requireBoolean(value.toolConcurrency, "tool concurrency"),
  };
}

function sanitizeCategory(value) {
  const categories = new Set([
    "adapter_protocol_error",
    "event_result_mismatch",
    "harness_error",
    "insufficient_tool_activity",
    "lifecycle_invalid",
    "timeout",
    "turn_interrupted",
    "worker_abnormal_exit",
    "worker_invalid_output",
  ]);
  if (typeof value !== "string" || !categories.has(value)) {
    throw new Error("invalid worker category");
  }
  return value;
}

function sanitizeFailure(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") throw new Error("invalid worker failure");
  if (value.code !== "HARNESS_ERROR" || value.operation !== "startTurn") {
    throw new Error("invalid worker failure");
  }
  return {
    code: "HARNESS_ERROR",
    operation: "startTurn",
    retryable: value.retryable === true,
  };
}

function requireNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid ${label}`);
  return value;
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") throw new Error(`invalid ${label}`);
  return value;
}

function requireBooleanOrNull(value, label) {
  if (value !== null && typeof value !== "boolean") throw new Error(`invalid ${label}`);
  return value;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function report(fields) {
  process.stdout.write(`${JSON.stringify({
    qualification,
    schemaVersion,
    timeoutMs,
    ...fields,
  }, null, 2)}\n`);
}
