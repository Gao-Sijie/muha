import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// D07 native selection research. Most cases stop at init or native rejection;
// --one-answer permits the first accepted known-model/high case to send at
// most one text-only Turn. The default never submits a model prompt.
const exec = promisify(execFile);
const evidenceRoot = process.env.MUHA_AGY_SELECTION_EVIDENCE_ROOT ?? tmpdir();
await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
const root = await mkdtemp(join(evidenceRoot, "muha-agy-selection-"));
const source = fileURLToPath(new URL("./", import.meta.url));
const helper = join(root, "supervisor");
const model = "claude-opus-4-6-thinking";
const report = { root, model, cases: [] };
const projectsRoot = join(homedir(), ".gemini/config/projects");
const settings = join(homedir(), ".gemini/antigravity-cli/settings.json");
const baseline = await fingerprints();
process.stdout.write(`${JSON.stringify({ evidence: root, stage: "compiling-selection-helper" })}\n`);
try {
  await exec("cc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-s", "-Wl,--wrap=__libc_start_main", "-o", helper,
    join(source, "supervisor.c"), join(source, "glibc-startup-compat.c")], { timeout: 10000 });
  report.version = (await exec("agy", ["--version"], { timeout: 10000 })).stdout.trim();
  const resumeOnlyIndex = process.argv.indexOf("--resume-low-only");
  if (resumeOnlyIndex !== -1) {
    const previous = JSON.parse(await readFile(process.argv[resumeOnlyIndex + 1], "utf8"));
    const reference = previous.cases.find(item => item.reference)?.reference;
    assert.ok(reference, "A previous report must contain a native resume reference");
    await run("resume-low", ["--model", model, "--effort", "low"], { reference });
  } else {
    const explicit = await run("known-high", ["--model", model, "--effort", "high"], { answer: process.argv.includes("--one-answer") });
    const resumable = explicit.init ? explicit : await run("known-no-effort", ["--model", model]);
    await run("bare-high", ["--effort", "high"]);
    await run("invalid-effort", ["--model", model, "--effort", "muha-invalid-effort"]);
    await run("invalid-model", ["--model", "muha-invalid-model"]);
    await run("known-low", ["--model", model, "--effort", "low"]);
    if (resumable.init?.conversation_id) {
      const reference = { id: resumable.init.conversation_id, workspace: resumable.workspace, project: await projectFor(resumable.workspace) };
      await run("resume-low", ["--model", model, "--effort", "low"], { reference });
      await run("resume-model-only", ["--model", model], { reference });
      await run("resume-bare-high", ["--effort", "high"], { reference });
      await run("resume-omitted", [], { reference });
    }
  }
  report.status = "native-selection-investigation-complete";
} catch (error) {
  report.status = "failed";
  report.failure = { name: error.name, message: error.message };
  process.exitCode = 1;
} finally {
  const after = await fingerprints();
  report.existingConfigurationChanged = [...baseline].filter(([path, hash]) => after.get(path) !== hash).map(([path]) => path);
  await writeFile(join(root, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function run(name, selection, { reference, answer = false } = {}) {
  const directory = join(root, name);
  await mkdir(directory);
  const workspace = reference?.workspace ?? join(directory, "workspace");
  if (!reference) await mkdir(workspace);
  const configurationBefore = await fingerprints();
  const native = [], controls = [];
  let stderr = "", ended = false, stdoutBuffer = "", controlBuffer = "";
  const args = ["--input-format", "stream-json", "--output-format", "stream-json", "--print-timeout", "120s",
    "--log-file", join(directory, "native.log"), ...selection];
  if (reference) args.push("--conversation", reference.id, "--project", reference.project);
  else args.push("--new-project", "--add-dir", workspace);
  const result = { name, workspace, selection, reference: reference ?? null };
  const child = spawn(helper, ["1000", "agy", ...args], { cwd: workspace, env: process.env, stdio: ["pipe", "pipe", "pipe", "pipe"] });
  const done = new Promise(resolve => {
    child.on("error", error => { result.spawnError = error.code; ended = true; resolve(); });
    child.on("close", (code, signal) => { result.helperExit = { code, signal }; ended = true; resolve(); });
  });
  const control = child.stdio[3];
  child.stdin.on("error", () => {});
  control.on("error", () => {});
  control.setEncoding("utf8");
  control.on("data", data => {
    controlBuffer += data;
    for (;;) {
      const index = controlBuffer.indexOf("\n"); if (index < 0) break;
      const event = JSON.parse(controlBuffer.slice(0, index)); controlBuffer = controlBuffer.slice(index + 1);
      controls.push(event);
      if (event.type === "ready") control.write("go\n");
    }
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", data => {
    stdoutBuffer += data;
    for (;;) {
      const index = stdoutBuffer.indexOf("\n"); if (index < 0) break;
      const line = stdoutBuffer.slice(0, index); stdoutBuffer = stdoutBuffer.slice(index + 1);
      try { native.push(JSON.parse(line)); } catch {}
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", data => { stderr += data; });
  try {
    await waitFor(() => native.some(event => event.event === "init" || event.event === "result") || ended, `${name} native selection`, 65000);
    const nativeInit = native.find(event => event.event === "init");
    result.init = nativeInit ? { event: nativeInit.event, conversation_id: nativeInit.conversation_id,
      init: { model: nativeInit.init.model, cwd: nativeInit.init.cwd, permission_mode: nativeInit.init.permission_mode, effort: nativeInit.init.effort } } : null;
    result.startupResult = native.find(event => event.event === "result")?.result ?? null;
    if (result.init) {
      assert.equal(result.init.init.cwd, workspace);
      if (result.init.init.model === undefined) {
        result.nativeInitOmittedModel = true;
      } else if (selection.includes(model)) assert.equal(result.init.init.model, model);
      if (reference) assert.equal(result.init.conversation_id, reference.id);
      if (answer && result.init.init.model === model && result.init.init.effort === undefined) {
        child.stdin.write(`${JSON.stringify({ event: "user", message: { content: [{ type: "text", text: "Reply exactly AGY_EFFORT_OK. Do not use tools." }] } })}\n`);
        result.sentOneTextTurn = true;
        await waitFor(() => native.some(event => event.event === "result") || ended, `${name} short text result`, 125000);
        result.turnResult = native.find(event => event.event === "result")?.result ?? null;
      }
      child.stdin.end();
      await waitFor(() => ended, `${name} graceful native EOF`, 3000).catch(() => control.write("close\n"));
    } else if (result.startupResult) await waitFor(() => ended, `${name} native rejection exit`, 3000);
  } catch (error) {
    result.probeError = { name: error.name, message: error.message };
  } finally {
    if (!ended) control.destroy();
    await done;
    result.nativeExit = controls.find(event => event.type === "nativeExit") ?? null;
    result.noChildren = controls.some(event => event.type === "closed" && event.noChildren && !event.cleanupError) || result.helperExit?.code === 0;
    result.selectionDiagnostics = stderr.split("\n").filter(line => /invalid|effort|model|select|not.support|not.recognized/i.test(line)).map(line => line.slice(0, 500));
    const configurationAfter = await fingerprints();
    result.existingConfigurationChanged = [...configurationBefore].filter(([path, hash]) => configurationAfter.get(path) !== hash).map(([path]) => path);
    await Promise.all([writeFile(join(directory, "native-events.json"), `${JSON.stringify(native, null, 2)}\n`, { mode: 0o600 }),
      writeFile(join(directory, "stderr.txt"), stderr, { mode: 0o600 }), writeFile(join(directory, "controls.json"), `${JSON.stringify(controls, null, 2)}\n`, { mode: 0o600 })]);
    report.cases.push(result);
    await writeFile(join(root, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ name, acceptedInit: Boolean(result.init), initModel: result.init?.init.model, startupError: result.startupResult?.error?.split("\n")[0],
      nativeExit: result.nativeExit, noChildren: result.noChildren, selectionDiagnostics: result.selectionDiagnostics, turnStatus: result.turnResult?.status, probeError: result.probeError })}\n`);
  }
  return result;
}
async function waitFor(predicate, label, timeout) {
  const deadline = performance.now() + timeout;
  do { if (predicate()) return; await delay(10); } while (performance.now() < deadline);
  throw new Error(`${label} exceeded ${timeout} ms`);
}
async function fingerprints() {
  const paths = [settings, ...(await readdir(projectsRoot)).filter(name => name.endsWith(".json")).map(name => join(projectsRoot, name))];
  return new Map(await Promise.all(paths.map(async path => [path, createHash("sha256").update(await readFile(path)).digest("hex")])));
}
async function projectFor(workspace) {
  for (const name of await readdir(projectsRoot)) {
    if (!name.endsWith(".json")) continue;
    const value = JSON.parse(await readFile(join(projectsRoot, name), "utf8"));
    if (JSON.stringify(value).includes(`file://${workspace}`)) return value.id ?? name.slice(0, -5);
  }
  throw new Error("Native Project binding was not found for the probe workspace");
}
