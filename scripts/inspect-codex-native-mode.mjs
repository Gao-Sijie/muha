import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

// Opt-in native persistence probe. Resume a known qualification Session without
// permission overrides or a model Turn; print only its effective mode fields.
const threadId = process.argv[2];
assert.match(threadId ?? "", /^[0-9a-f-]{36}$/);
const child = spawn("codex", ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
child.stderr.resume();
const pending = new Map();
let sequence = 0;
const lines = createInterface({ input: child.stdout });
const closed = new Promise((resolve) => child.once("close", resolve));
child.once("error", fail);
child.once("exit", () => fail(new Error("Codex exited before the probe completed")));
lines.on("line", (line) => {
  try {
    const value = JSON.parse(line);
    const request = pending.get(value.id);
    if (!request) return;
    pending.delete(value.id);
    if (value.error) request.reject(new Error(value.error.message));
    else request.resolve(value.result);
  } catch (error) { fail(error); }
});
const timer = setTimeout(() => { fail(new Error("Native mode probe timed out")); child.kill("SIGKILL"); }, 15_000);
try {
  await request("initialize", { clientInfo: { name: "muha-native-mode-qualification", version: "0.1.12" } });
  child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
  const result = await request("thread/resume", { threadId });
  assert.equal(result.thread.id, threadId);
  process.stdout.write(`${JSON.stringify({ threadId, approvalPolicy: result.approvalPolicy, sandbox: result.sandbox, model: result.model }, null, 2)}\n`);
} finally {
  child.stdin.end();
  await closed;
  clearTimeout(timer);
  lines.close();
}
function request(method, params) {
  return new Promise((resolve, reject) => {
    pending.set(++sequence, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ id: sequence, method, params })}\n`);
  });
}
function fail(error) {
  for (const request of pending.values()) request.reject(error);
  pending.clear();
}
