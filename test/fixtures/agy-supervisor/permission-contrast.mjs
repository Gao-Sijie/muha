import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

// Two real Claude Turns against the Project configured by permission-setup.
// No configuration writes, credential copies, or automatic model retries.
const setup = JSON.parse(await readFile(process.argv[2], "utf8"));
const skipCreateOnly = process.argv.includes("--skip-create-only");
const exec = promisify(execFile);
const rule = "command(printf MUHA_D08_DENY)";
const candidates = await Promise.all(setup.newProjectFiles.map(async path => ({ path, value: JSON.parse(await readFile(path, "utf8")) })));
const project = candidates.find(item => item.value.projectResources?.resources?.some(resource => resource.folderUri === `file://${setup.workspace}`));
assert.ok(project, "Setup must identify its own new Project");
assert.ok(project.value.permissionGrants?.permissionGrants?.deny?.includes(rule), "Native Project must contain the rule saved through the TUI");
const root = join(setup.root, skipCreateOnly ? "contrast-skip-create" : "contrast");
await mkdir(root);
const baseline = await fingerprints();
const report = { root, projectId: project.value.id, workspace: setup.workspace, rule, cases: [] };
try {
  report.versionBefore = (await exec("agy", ["--version"], { timeout: 10000 })).stdout.trim();
  if (skipCreateOnly) await run("skip-create", true);
  else {
    const managed = await run("managed", false);
    assert.ok(managed.init?.conversation_id, "First native Session did not initialize");
    await run("skip", true, managed.init.conversation_id);
  }
} finally {
  const after = await fingerprints();
  report.existingConfigurationChanged = [...baseline].filter(([path, hash]) => after.get(path) !== hash).map(([path]) => path);
  report.versionAfter = (await exec("agy", ["--version"], { timeout: 10000 })).stdout.trim();
  await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function run(name, skip, conversation) {
  const directory = join(root, name);
  await mkdir(directory);
  const marker = join(setup.workspace, `denied-${name}.txt`);
  assert.equal(await stat(marker).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; }), false);
  const args = ["--input-format", "stream-json", "--output-format", "stream-json", "--print-timeout", "120s",
    "--model", setup.model, "--project", project.value.id, "--log-file", join(directory, "native.log")];
  if (skip) args.push("--dangerously-skip-permissions");
  if (conversation) args.push("--conversation", conversation);
  const result = { name, args, turnsSubmitted: 0 };
  const events = [], controls = [];
  let stderr = "", ended = false;
  const child = spawn(join(setup.root, "supervisor"), ["1000", "agy", ...args], { cwd: setup.workspace, env: process.env, stdio: ["pipe", "pipe", "pipe", "pipe"] });
  const control = child.stdio[3];
  const done = new Promise(resolve => {
    child.on("error", error => { result.spawnError = error.code; ended = true; resolve(); });
    child.on("close", (code, signal) => { result.helperExit = { code, signal }; ended = true; resolve(); });
  });
  child.stdin.on("error", () => {}); control.on("error", () => {});
  lines(control, line => { const event = JSON.parse(line); controls.push(event); if (event.type === "ready") control.write("go\n"); });
  lines(child.stdout, line => { try { events.push(JSON.parse(line)); } catch { result.malformedNativeLine = true; } });
  child.stderr.setEncoding("utf8"); child.stderr.on("data", data => { stderr += data; });
  try {
    await waitFor(() => events.some(event => event.event === "init" || event.event === "result") || ended, "init", 65000);
    const init = events.find(event => event.event === "init");
    result.init = init ? { conversation_id: init.conversation_id, model: init.init.model, cwd: init.init.cwd, permission_mode: init.init.permission_mode } : null;
    assert.ok(init, "Native initialization failed; no prompt submitted");
    assert.equal(init.init.model, setup.model); assert.equal(init.init.cwd, setup.workspace);
    if (conversation) assert.equal(init.conversation_id, conversation);
    assert.equal(init.init.permission_mode, skip ? "always-proceed" : "request-review");
    result.prompt = `Use run_command exactly once to execute this exact command in the current workspace: printf MUHA_D08_DENY > denied-${name}.txt . ` +
      "This is a bounded native permission observation. If denied, do not retry or use any substitute tool. " +
      "Do not edit permissions, configuration, or other files; do not request extra approval, access the network, or start background work. Afterwards reply DONE.";
    child.stdin.write(`${JSON.stringify({ event: "user", message: { content: result.prompt } })}\n`);
    result.turnsSubmitted = 1;
    await waitFor(() => events.some(event => event.event === "result") || ended, "native Turn", 130000);
    result.result = events.find(event => event.event === "result")?.result ?? null;
    child.stdin.end();
    await waitFor(() => ended, "native EOF", 3000).catch(() => control.write("close\n"));
  } catch (error) {
    result.probeError = { name: error.name, message: error.message };
    process.exitCode = 1;
  } finally {
    if (!ended) control.destroy();
    await done;
    result.nativeExit = controls.find(event => event.type === "nativeExit") ?? null;
    result.noChildren = controls.some(event => event.type === "closed" && event.noChildren && !event.cleanupError) || result.helperExit?.code === 0;
    result.toolEvents = events.filter(event => event.event === "step_update" && event.step_update?.step_type === "tool");
    result.marker = await readFile(marker, "utf8").then(content => ({ exists: true, content }), error => { if (error.code === "ENOENT") return { exists: false }; throw error; });
    await Promise.all([
      writeFile(join(directory, "native-events.json"), JSON.stringify(events, null, 2), { mode: 0o600 }),
      writeFile(join(directory, "controls.json"), JSON.stringify(controls, null, 2), { mode: 0o600 }),
      writeFile(join(directory, "stderr.txt"), stderr, { mode: 0o600 })
    ]);
    report.cases.push(result);
    await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ name, init: result.init, marker: result.marker, noChildren: result.noChildren, probeError: result.probeError })}\n`);
  }
  return result;
}
function lines(stream, callback) {
  let buffer = ""; stream.setEncoding("utf8");
  stream.on("data", data => {
    buffer += data;
    for (;;) { const index = buffer.indexOf("\n"); if (index < 0) break; const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); callback(line); }
  });
}
async function waitFor(predicate, label, timeout) {
  const deadline = performance.now() + timeout;
  do { if (predicate()) return; await delay(10); } while (performance.now() < deadline);
  throw new Error(`${label} exceeded ${timeout}ms`);
}
async function fingerprints() {
  const projects = join(homedir(), ".gemini/config/projects");
  const paths = [join(homedir(), ".gemini/antigravity-cli/settings.json"), join(homedir(), ".gemini/config/config.json"),
    ...(await readdir(projects)).filter(name => name.endsWith(".json")).map(name => join(projects, name))];
  return new Map(await Promise.all(paths.map(async path => [path, createHash("sha256").update(await readFile(path)).digest("hex")])));
}
