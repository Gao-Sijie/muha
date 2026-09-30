import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// Deliberately invokes the real AGY CLI and one real Claude tool Turn. This is
// D02 native evidence, not public Adapter/D15 qualification. Projects/history
// created by AGY are retained. There are no namespace or SDK calls.
const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "muha-agy-subreaper-real-"));
const workspace = join(root, "workspace"), owned = join(workspace, "owned"), outsiderDir = join(root, "outsider");
await Promise.all([mkdir(owned, { recursive: true }), mkdir(outsiderDir)]);
const helper = join(root, "supervisor"), writer = join(root, "workload");
const source = fileURLToPath(new URL("./", import.meta.url));
const report = { root, workspace, model: "claude-opus-4-6-thinking", checks: [] };
let cli, outsider, control, nativePid, childExited = false, childCompletion;
const controls = [], native = [];
let stderr = "", stdoutPending = "", controlPending = "";
process.stdout.write(`${JSON.stringify({ evidence: root, stage: "compiling" })}\n`);
try {
  for (const name of ["supervisor", "workload"]) await exec("cc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-static", "-s", "-o", join(root, name), join(source, `${name}.c`)], { timeout: 10000 });
  report.helperSha256 = createHash("sha256").update(await readFile(helper)).digest("hex");
  report.agyVersion = (await exec("agy", ["--version"], { timeout: 10000 })).stdout.trim();
  const command = `setsid ${quote(writer)} outsider ${quote(owned)} </dev/null >/dev/null 2>&1 & sleep 8`;
  const prompt = `Use your shell execution tool exactly once to run this exact command, then stop. Do not inspect, edit or delete any file and do not substitute another command. The executable is a self-terminating ten-second lifecycle test heartbeat.\n${command}`;
  const args = ["--new-project", "--add-dir", workspace, "--model", report.model, "--dangerously-skip-permissions", "--output-format", "stream-json",
    "--print-timeout", "120s", "--log-file", join(root, "native.log"), "--print", prompt];
  report.args = args;
  cli = spawn(helper, ["2000", "agy", ...args], { cwd: workspace, env: process.env, stdio: ["pipe", "pipe", "pipe", "pipe"] });
  childCompletion = new Promise(resolve => {
    cli.on("error", error => { childExited = true; report.helperError = error.code; resolve(); });
    cli.on("close", (code, signal) => { childExited = true; report.helperExit = { code, signal }; resolve(); });
  });
  cli.stdin.on("error", () => {});
  control = cli.stdio[3];
  control.on("error", () => {});
  control.setEncoding("utf8");
  control.on("data", data => {
    controlPending += data;
    for (;;) {
      const split = controlPending.indexOf("\n");
      if (split < 0) break;
      const event = JSON.parse(controlPending.slice(0, split));
      controls.push(event);
      controlPending = controlPending.slice(split + 1);
      if (event.type === "ready") control.write("go\n");
      if (event.type === "spawned") nativePid = event.pid;
    }
  });
  cli.stdout.setEncoding("utf8");
  cli.stdout.on("data", data => {
    stdoutPending += data;
    for (;;) {
      const split = stdoutPending.indexOf("\n");
      if (split < 0) break;
      const line = stdoutPending.slice(0, split);
      stdoutPending = stdoutPending.slice(split + 1);
      try {
        const event = JSON.parse(line);
        native.push(event);
        if (event.event === "init") process.stdout.write(`${JSON.stringify({ stage: "native-ready", event: event.event })}\n`);
      } catch { /* Native non-protocol text is not promoted to proof. */ }
    }
  });
  cli.stderr.setEncoding("utf8");
  cli.stderr.on("data", data => { stderr += data; });
  await waitFor(async () => {
    if (await writes(owned) > 0) return true;
    assert.equal(childExited, false, "AGY exited before executing the heartbeat tool");
    return false;
  }, "real AGY shell heartbeat", 125000);
  const entries = (await readFile(join(owned, "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const init = native.find(event => event.init)?.init;
  assert.equal(init?.model, report.model);
  assert.equal(init.cwd, workspace);
  assert.equal(init.permission_mode, "always-proceed");
  const heartbeat = entries.find(event => event.kind === "writer");
  assert.ok(heartbeat);
  assert.equal(heartbeat.pid, heartbeat.group, "Heartbeat must be in its own setsid process group");
  assert.notEqual(heartbeat.group, nativePid);
  report.heartbeat = heartbeat;
  report.ancestry = await ancestors(heartbeat.pid, cli.pid);
  assert.ok(report.ancestry.some(entry => entry.pid === cli.pid), "Real tool must belong to this helper's process tree");
  assert.ok(nativePid > 1 && !childExited);
  const nativeBirth = await identity(nativePid);
  assert.ok(nativeBirth);
  outsider = spawn(writer, ["outsider", outsiderDir], { stdio: "ignore" });
  const outsiderCompletion = new Promise(resolve => outsider.once("close", resolve));
  await waitFor(async () => await writes(outsiderDir) > 0, "unrelated writer", 1000);
  const otherBefore = await writes(outsiderDir);
  assert.equal(await identity(nativePid), nativeBirth);
  const started = performance.now();
  process.kill(nativePid, "SIGKILL");
  await waitFor(async () => childExited, "real AGY owned process cleanup", 2500);
  report.cleanupMs = Math.round(performance.now() - started);
  assert.ok(controls.some(event => event.type === "nativeExit" && event.signal === 9));
  assert.ok(controls.some(event => event.type === "closed" && event.noChildren && !event.cleanupError));
  assert.deepEqual(report.helperExit, { code: 0, signal: null });
  const stopped = await writes(owned);
  await delay(300);
  assert.equal(await writes(owned), stopped, "Real native heartbeat wrote after helper closed");
  assert.ok(await writes(outsiderDir) > otherBefore, "Unrelated writer was affected");
  assert.equal(await identity(heartbeat.pid), null, "Real owned heartbeat survived cleanup");
  outsider.kill("SIGKILL");
  await outsiderCompletion;
  outsider = undefined;
  report.checks.push("real-agy-cli-with-claude-opus-4-6", "native-autoapprove-executes-shell", "real-setsid-heartbeat-descends-from-helper",
    "native-sigkill-observed-with-helper-alive", "echild-before-helper-exit", "owned-file-stays-stopped-after-close", "unrelated-same-user-writer-survives");
  report.status = "native-d02-proof-passed-not-adapter-or-d15-qualification";
} catch (error) {
  report.status = "failed";
  report.failure = { name: error.name, message: error.message };
  process.exitCode = 1;
} finally {
  if (cli && !childExited) control?.destroy();
  outsider?.kill("SIGKILL");
  await childCompletion;
  report.controls = controls;
  report.nativeEventTypes = [...new Set(native.map(event => event.event))];
  report.nativeInit = native.find(event => event.init)?.init ?? null;
  await Promise.all([
    writeFile(join(root, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }),
    writeFile(join(root, "native-events.json"), `${JSON.stringify(native, null, 2)}\n`, { mode: 0o600 }),
    writeFile(join(root, "stderr.txt"), stderr, { mode: 0o600 }),
  ]);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function quote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }
async function waitFor(predicate, label, bound) {
  const deadline = performance.now() + bound;
  do { if (await predicate()) return; await delay(10); } while (performance.now() < deadline);
  throw new Error(`${label} exceeded ${bound} ms`);
}
async function writes(directory) {
  return (await Promise.all((await readdir(directory)).filter(name => name.startsWith("writes-")).map(async name => (await stat(join(directory, name))).size))).reduce((sum, size) => sum + size, 0);
}
async function identity(pid) {
  try { const text = await readFile(`/proc/${pid}/stat`, "utf8"); const fields = text.slice(text.lastIndexOf(")") + 2).split(" "); return fields[0] === "Z" ? null : fields[19]; }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
async function ancestors(pid, target) {
  const chain = [];
  for (let index = 0; index < 32 && pid > 1; index++) {
    const text = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    chain.push({ pid, parent: Number(fields[1]), startTime: fields[19] });
    if (pid === target) break;
    pid = Number(fields[1]);
  }
  return chain;
}
