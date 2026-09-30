import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// Default: one real Claude Turn, no rule changes or automatic retries.
// --protocol-error: an init-only unsupported control message; no model prompt.
// --timeout-probe: one text input with a 1ms native timeout; records both pipes.
const exec = promisify(execFile);
const protocolError = process.argv.includes("--protocol-error");
const timeoutProbe = process.argv.includes("--timeout-probe");
if (protocolError && timeoutProbe) throw new Error("Choose one probe mode");
const evidenceRoot = resolve(".scratch/agy-native-qualification");
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const root = await mkdtemp(join(evidenceRoot, protocolError ? "muha-agy-error-" : timeoutProbe ? "muha-agy-timeout-" : "muha-agy-denial-"));
const workspace = join(root, "workspace");
await mkdir(workspace);
const source = fileURLToPath(new URL("./", import.meta.url));
const helper = join(root, "supervisor");
const baseline = await fingerprints();
const report = { root, workspace, model: "claude-opus-4-6-thinking", protocolError, timeoutProbe, turnsSubmitted: 0, stdioTimeline: [] };
const startedAt = performance.now();
const events = [], controls = [];
let stderr = "", ended = false;
let child, control, done;
process.stdout.write(`${JSON.stringify({ root, stage: "compiling-owned-denial-helper" })}\n`);
try {
  await exec("cc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-s", "-Wl,--wrap=__libc_start_main", "-o", helper,
    join(source, "supervisor.c"), join(source, "glibc-startup-compat.c")], { timeout: 10000 });
  report.versionBefore = (await exec("agy", ["--version"], { timeout: 10000 })).stdout.trim();
  report.args = ["--input-format", "stream-json", "--output-format", "stream-json", "--print-timeout", timeoutProbe ? "1ms" : "120s",
    "--model", report.model, "--new-project", "--add-dir", workspace, "--log-file", join(root, "native.log")];
  child = spawn(helper, ["1000", "agy", ...report.args], { cwd: workspace, env: process.env, stdio: ["pipe", "pipe", "pipe", "pipe"] });
  control = child.stdio[3];
  done = new Promise(resolve => {
    child.on("error", error => { report.spawnError = error.code; ended = true; resolve(); });
    child.on("close", (code, signal) => { report.helperExit = { code, signal }; ended = true; resolve(); });
  });
  child.stdin.on("error", () => {});
  control.on("error", () => {});
  lines(control, line => {
    const event = JSON.parse(line);
    controls.push(event);
    if (event.type === "ready") control.write("go\n");
  });
  lines(child.stdout, line => {
    try {
      const event = JSON.parse(line);
      events.push(event);
      if (timeoutProbe) report.stdioTimeline.push({ channel: "stdout", atMs: performance.now() - startedAt, event: event.event });
    } catch { report.malformedNativeLine = true; }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", data => {
    stderr += data;
    if (timeoutProbe) report.stdioTimeline.push({ channel: "stderr", atMs: performance.now() - startedAt, text: data });
  });
  await waitFor(() => events.some(event => event.event === "init" || event.event === "result") || ended, "native init", 65000);
  const init = events.find(event => event.event === "init");
  report.init = init ? { conversation_id: init.conversation_id, ...Object.fromEntries(["cwd", "model", "permission_mode"].map(key => [key, init.init[key]])) } : null;
  if (!init) throw new Error("Native initialization did not succeed; no model prompt was submitted");
  if (init.init.model !== report.model || init.init.cwd !== workspace || init.init.permission_mode !== "request-review") {
    throw new Error("Native configuration differs from this probe's required baseline; no model prompt was submitted");
  }
  if (protocolError) {
    report.input = { event: "control_request" };
    child.stdin.write(`${JSON.stringify(report.input)}\n`);
    await waitFor(() => events.some(event => event.event === "result") || ended, "native protocol rejection", 10000);
    report.result = events.find(event => event.event === "result")?.result ?? null;
    await waitFor(() => ended, "native rejection exit without consumer EOF", 3000);
    report.nativeExitedWithoutConsumerEOF = true;
  } else {
    report.prompt = timeoutProbe ? "Reply exactly MUHA_TIMEOUT_TEXT. Do not use tools." :
    "This is a bounded tool permission observation. Make exactly two separate run_command tool calls in this turn. " +
    "First command: printf MUHA_DENIAL_A > denial-a.txt . Second command: printf MUHA_DENIAL_B > denial-b.txt . " +
    "Use the current working directory for both. Do not combine them into one command. " +
    "If the first is denied, still attempt the second once if the native tool flow permits. " +
    "Do not retry a denied command, request additional permissions, modify settings, use a different tool, read other files, " +
    "access the network, or start background work. After these attempts, reply DONE. Native denial is an expected observation.";
    const submittedAt = performance.now();
    child.stdin.write(`${JSON.stringify({ event: "user", message: { content: report.prompt } })}\n`);
    report.turnsSubmitted = 1;
    await waitFor(() => events.some(event => event.event === "result") || ended, "one native Turn", timeoutProbe ? 15000 : 130000);
    report.result = events.find(event => event.event === "result")?.result ?? null;
    if (timeoutProbe) {
      report.resultAfterInputMs = performance.now() - submittedAt;
      await delay(250);
      report.nativeAlive250msAfterResult = !controls.some(event => event.type === "nativeExit");
    }
    child.stdin.end();
    await waitFor(() => ended, "native EOF", 3000).catch(() => control.write("close\n"));
  }
} catch (error) {
  report.probeError = { name: error.name, message: error.message };
  process.exitCode = 1;
} finally {
  if (child && !ended) control.destroy();
  if (done) await done;
  report.nativeExit = controls.find(event => event.type === "nativeExit") ?? null;
  report.noChildren = controls.some(event => event.type === "closed" && event.noChildren && !event.cleanupError) || report.helperExit?.code === 0;
  report.toolEvents = events.filter(event => event.event === "step_update" && event.step_update?.step_type === "tool");
  report.markers = {};
  for (const name of ["denial-a.txt", "denial-b.txt"]) {
    try { report.markers[name] = { exists: true, bytes: (await stat(join(workspace, name))).size }; }
    catch (error) { if (error.code !== "ENOENT") throw error; report.markers[name] = { exists: false }; }
  }
  const after = await fingerprints();
  report.existingConfigurationChanged = [...baseline].filter(([path, hash]) => after.get(path) !== hash).map(([path]) => path);
  report.versionAfter = await exec("agy", ["--version"], { timeout: 10000 }).then(result => result.stdout.trim(), error => ({ error: error.code }));
  if (timeoutProbe) {
    report.timeoutLogLines = await readFile(join(root, "native.log"), "utf8")
      .then(value => value.split("\n").filter(line => /print timeout|returning partial/u.test(line)), error => [{ error: error.code }]);
  }
  await Promise.all([
    writeFile(join(root, "native-events.json"), `${JSON.stringify(events, null, 2)}\n`, { mode: 0o600 }),
    writeFile(join(root, "controls.json"), `${JSON.stringify(controls, null, 2)}\n`, { mode: 0o600 }),
    writeFile(join(root, "stderr.txt"), stderr, { mode: 0o600 }),
    writeFile(join(root, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  ]);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function lines(stream, callback) {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", data => {
    buffer += data;
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      callback(line);
    }
  });
}
async function waitFor(predicate, label, timeout) {
  const deadline = performance.now() + timeout;
  do { if (predicate()) return; await delay(10); } while (performance.now() < deadline);
  throw new Error(`${label} exceeded ${timeout} ms`);
}
async function fingerprints() {
  const projects = join(homedir(), ".gemini/config/projects");
  const paths = [join(homedir(), ".gemini/antigravity-cli/settings.json"),
    ...(await readdir(projects)).filter(name => name.endsWith(".json")).map(name => join(projects, name))];
  return new Map(await Promise.all(paths.map(async path => [path, createHash("sha256").update(await readFile(path)).digest("hex")])));
}
