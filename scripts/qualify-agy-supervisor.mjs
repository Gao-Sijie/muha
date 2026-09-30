import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, readlink, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// Independent research proof. Compilation happens in this qualification, never
// at consumer installation or Runtime startup. No model/namespace/systemd calls.
const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "muha-agy-subreaper-"));
const source = fileURLToPath(new URL("../test/fixtures/agy-supervisor/", import.meta.url));
const helper = join(root, "supervisor");
const workload = join(root, "workload");
const dynamicHelper = process.argv.includes("--dynamic");
const report = { root, kind: "agy-subreaper-helper-alive-proof", cases: [], checks: [] };
const children = new Set();
const environment = { ...process.env, MUHA_SUPERVISOR_MARKER: "原生 $literal `literal` \"quoted\"" };
delete environment.MUHA_SUPERVISOR_REMOVED;
const hostBefore = hostState();

try {
  for (const name of ["supervisor", "workload"]) {
    const linkage = name === "supervisor" && dynamicHelper ? ["-Wl,--wrap=__libc_start_main", join(source, "glibc-startup-compat.c")] : ["-static"];
    await exec("cc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", ...linkage, "-s", "-o", join(root, name), join(source, `${name}.c`)], { timeout: 10000 });
  }
  const { stdout: headers } = await exec("readelf", ["-l", helper]);
  if (dynamicHelper) assert.match(headers, /INTERP/);
  else assert.doesNotMatch(headers, /INTERP|Requesting program interpreter/);
  const { stdout: dynamic } = await exec("readelf", ["-d", helper]);
  if (dynamicHelper) {
    assert.match(dynamic, /Shared library: \[libc.so.6\]/);
    const { stdout: versions } = await exec("readelf", ["--version-info", helper]);
    report.glibcRequirements = [...new Set(versions.match(/GLIBC_\d+\.\d+(?:\.\d+)?/g))];
    for (const version of report.glibcRequirements) {
      const [, major, minor] = /^GLIBC_(\d+)\.(\d+)/.exec(version);
      assert.ok(Number(major) < 2 || Number(major) === 2 && Number(minor) <= 28, "Helper raised the supported libc floor");
    }
  } else assert.doesNotMatch(dynamic, /NEEDED/);
  report.helperBytes = (await stat(helper)).size;
  report.helperSha256 = createHash("sha256").update(await readFile(helper)).digest("hex");
  report.checks.push(dynamicHelper ? "dynamic-helper-symbol-requirements-within-glibc-2-28" : "static-elf-no-interpreter-or-shared-library-dependency");
  report.loader = process.env.MUHA_SUPERVISOR_LOADER ?? null;

  const smoke = start(helper, ["200", "/bin/echo", "SMOKE_OK"], root);
  await ready(smoke);
  smoke.control.write("go\n");
  await closed(smoke);
  assert.equal(smoke.stdout, "SMOKE_OK\n");
  assert.deepEqual(nativeExit(smoke), { code: 0, signal: 0 });
  report.checks.push("helper-echo-smoke-and-native-exit-cause");

  const unrelatedDir = join(root, "unrelated");
  await mkdir(unrelatedDir);
  const unrelated = track(spawn(workload, ["outsider", unrelatedDir], { stdio: "ignore" }));
  await waitFor(async () => await writes(unrelatedDir) > 0, "unrelated writer ready");
  const peer = await session("other-session");
  for (const mode of ["normal-exit", "native-sigkill", "close", "interrupt", "control-eof"]) {
    const state = await session(mode);
    const ownEvents = await events(state.directory);
    const births = await Promise.all(ownEvents.filter(event => event.kind === "writer").map(async event => ({ pid: event.pid, identity: await identity(event.pid) })));
    const peerWrites = await writes(peer.directory), unrelatedWrites = await writes(unrelatedDir);
    const started = performance.now();
    if (mode === "normal-exit") state.child.stdin.write("exit\n");
    else if (mode === "native-sigkill") state.child.stdin.write("crash\n");
    else if (mode === "control-eof") state.control.destroy();
    else state.control.write(`${mode}\n`);
    await closed(state, 1500, false, mode === "control-eof");
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 1500, "Cleanup did not complete within the qualification bound");
    assert.equal(state.events.filter(event => event.type === "closed").length, mode === "control-eof" ? 0 : 1);
    const finishedEvents = await events(state.directory);
    const lateForks = finishedEvents.filter(event => event.kind === "writer" && event.name === "after-stop").length;
    if (["close", "interrupt"].includes(mode)) assert.equal(lateForks, 3);
    for (const birth of births) {
      const current = await identity(birth.pid);
      assert.ok(current === null || current !== birth.identity, "An owned writer survived confirmed ECHILD");
    }
    const stoppedWrites = await writes(state.directory);
    await delay(100);
    assert.equal(await writes(state.directory), stoppedWrites);
    assert.ok(await writes(peer.directory) > peerWrites, "The other Session was stopped");
    assert.ok(await writes(unrelatedDir) > unrelatedWrites, "An unrelated same-user process was stopped");
    const expected = mode === "control-eof" ? null : mode === "normal-exit" ? { code: 42, signal: 0 } : { code: -1, signal: 9 };
    if (expected) assert.deepEqual(nativeExit(state), expected);
    report.cases.push({ mode, cleanupMs: Math.round(elapsed), nativeExit: expected, lateForks, noChildren: true, otherSessionAlive: true, unrelatedWriterAlive: true });
  }

  peer.child.stdin.write("PEER_STILL_RESPONDS\n");
  await waitFor(async () => peer.stdout.includes("PEER_STILL_RESPONDS\n"), "peer native stdin remains usable");
  peer.control.write("close\n");
  await closed(peer);
  unrelated.child.kill("SIGKILL");
  await unrelated.completion;

  const cancelledDir = join(root, "cancel-before-go");
  await mkdir(cancelledDir);
  const cancelled = start(helper, ["200", workload, "cli", cancelledDir], cancelledDir);
  await ready(cancelled);
  cancelled.control.destroy();
  await closed(cancelled, 1500, false, true);
  assert.equal(cancelled.events.some(event => event.type === "spawned"), false);
  assert.equal(await access(join(cancelledDir, "snapshot.txt")).then(() => true, () => false), false);
  report.checks.push("control-eof-before-go-spawns-no-native-process");

  const missing = start(helper, ["200", join(root, "missing-executable")], root);
  await ready(missing);
  missing.control.write("go\n");
  await closed(missing, 1500, true);
  assert.equal(missing.events.some(event => event.type === "spawned"), false);
  assert.ok(missing.events.some(event => event.type === "error" && event.operation === "exec" && event.errno === 2));
  assert.deepEqual(nativeExit(missing), { code: 127, signal: 0 });
  report.checks.push("exec-failure-reported-and-reclaimed", "setsid-independent-groups-double-fork-and-nested-subreaper",
    "late-forks-reclaimed-until-echild", "distinct-control-fd-closed-before-native-exec", "native-stdio-passthrough",
    "cwd-environment-primary-and-supplementary-groups-preserved", "native-subreaper-flag-unset",
    "pid-user-mount-namespaces-unchanged", "session-isolation", "helper-death-explicitly-outside-guarantee");
  assert.deepEqual(hostState(), hostBefore);
  report.status = "synthetic-proof-passed-real-agy-not-qualified";
} catch (error) {
  report.status = "failed";
  report.failure = { name: error.name, message: error.message };
  process.exitCode = 1;
} finally {
  for (const state of children) if (!state.exited) {
    if (state.control) state.control.destroy();
    else state.child.kill("SIGKILL");
  }
  // Keep the ownership helper alive to drain adopted children on every error.
  // Workload descendants additionally expire after ten seconds on their own.
  await Promise.all([...children].map(state => state.completion));
  await writeFile(join(root, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function track(child) {
  const state = { child, exited: false, stdout: "", stderr: "", events: [] };
  children.add(state);
  state.completion = new Promise(resolve => {
    child.once("error", error => { state.exited = true; state.error = error.code; resolve(); });
    child.once("close", (code, signal) => { state.exited = true; state.code = code; state.signal = signal; resolve(); });
  });
  child.stdin?.on("error", () => {});
  child.stdout?.on("data", data => { state.stdout += data; });
  child.stderr?.on("data", data => { state.stderr += data; });
  return state;
}
function start(executable, args, cwd) {
  if (executable === helper && process.env.MUHA_SUPERVISOR_LOADER) {
    args = ["--library-path", process.env.MUHA_SUPERVISOR_LIBRARY_PATH, executable, ...args];
    executable = process.env.MUHA_SUPERVISOR_LOADER;
  }
  const state = track(spawn(executable, args, { cwd, env: environment, stdio: ["pipe", "pipe", "pipe", "pipe"] }));
  state.control = state.child.stdio[3];
  state.control.on("error", () => {});
  let buffer = "";
  state.control.setEncoding("utf8");
  state.control.on("data", text => {
    buffer += text;
    for (;;) {
      const split = buffer.indexOf("\n");
      if (split < 0) return;
      state.events.push(JSON.parse(buffer.slice(0, split)));
      buffer = buffer.slice(split + 1);
    }
  });
  return state;
}
async function ready(state) {
  await waitFor(async () => state.events.some(event => event.type === "ready"), "helper ready");
}
async function closed(state, bound = 1500, expectError = false, controlLost = false) {
  await waitFor(async () => state.exited, "helper complete closure", bound);
  const terminal = state.events.find(event => event.type === "closed");
  if (!controlLost) {
    assert.equal(terminal?.noChildren, true);
    assert.equal(terminal.cleanupError, expectError);
  }
  assert.equal(state.code, expectError ? 125 : 0);
}
async function session(name) {
  const directory = join(root, name);
  await mkdir(directory);
  const state = start(helper, ["200", workload, "cli", directory], directory);
  state.directory = directory;
  await ready(state);
  state.control.write("go\n");
  await waitFor(async () => (await events(directory)).filter(event => event.kind === "writer").length >= 5, `${name}: writers ready`);
  const snapshot = Object.fromEntries((await readFile(join(directory, "snapshot.txt"), "utf8")).trim().split("\n").map(line => { const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)]; }));
  assert.equal(snapshot.cwd, directory);
  assert.equal(Number(snapshot.uid), process.getuid());
  assert.equal(Number(snapshot.gid), process.getgid());
  assert.deepEqual(snapshot.groups.split(",").filter(Boolean).map(Number).sort((a, b) => a - b), process.getgroups().sort((a, b) => a - b));
  assert.equal(snapshot.subreaper, "0");
  assert.equal(snapshot.controlClosed, "1");
  assert.equal(snapshot.sigchldBlocked, "0");
  for (const name of ["pid", "user", "mnt"]) assert.equal(snapshot[`${name}Namespace`], await readlink(`/proc/self/ns/${name}`));
  assert.equal((await readFile(join(directory, "environment.fingerprint"), "utf8")).trim(), fingerprint(environment));
  const echo = "NATIVE_ECHO 空格 $literal `literal` \"quoted\"\n";
  state.child.stdin.write(echo);
  await waitFor(async () => state.stdout.includes(echo) && state.stderr.includes("NATIVE_STDERR_READY\n"), "native stdio echo");
  return state;
}
function nativeExit(state) {
  const event = state.events.find(event => event.type === "nativeExit");
  assert.ok(event);
  return { code: event.code, signal: event.signal };
}
function fingerprint(env) {
  let value = 14695981039346656037n;
  for (const byte of Buffer.from(Object.entries(env).map(([key, value]) => `${key}=${value}\0`).join(""))) {
    value = BigInt.asUintN(64, (value ^ BigInt(byte)) * 1099511628211n);
  }
  return value.toString(16).padStart(16, "0");
}
function hostState() {
  return { cwd: process.cwd(), envHash: createHash("sha256").update(JSON.stringify(process.env)).digest("hex"), uid: process.getuid(), gid: process.getgid(), groups: process.getgroups(),
    signals: Object.fromEntries(["SIGINT", "SIGTERM", "beforeExit", "uncaughtException", "unhandledRejection"].map(name => [name, process.listenerCount(name)])) };
}
async function waitFor(predicate, name, bound = 2000) {
  const deadline = performance.now() + bound;
  do { if (await predicate()) return; await delay(5); } while (performance.now() < deadline);
  throw new Error(`${name} exceeded ${bound} ms`);
}
async function events(directory) {
  try { return (await readFile(join(directory, "events.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
async function writes(directory) {
  return (await Promise.all((await readdir(directory)).filter(name => name.startsWith("writes-")).map(async name => (await stat(join(directory, name))).size))).reduce((sum, size) => sum + size, 0);
}
async function identity(pid) {
  try { const text = await readFile(`/proc/${pid}/stat`, "utf8"); const fields = text.slice(text.lastIndexOf(")") + 2).split(" "); return fields[0] === "Z" ? null : fields[19]; }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
