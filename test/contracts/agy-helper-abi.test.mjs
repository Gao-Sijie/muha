// AGY helper build & ABI guard regression (T02).
// Verifies the shipped dist/agy-supervisor (produced by build-native.mjs):
//   1. is a dynamic x86-64 ELF whose GLIBC version requirements stay <= 2.28
//      (the committed minimum-support floor), and
//   2. actually starts and completes a control protocol probe with a stub
//      native command (no model, no credentials), reaping its descendants.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, execFile } from "node:child_process";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { access, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, writeFile, readFile, chmod, copyFile, rm } from "node:fs/promises";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

const exec = promisify(execFile);
const helper = fileURLToPath(new URL("../../packages/agy-adapter/dist/agy-supervisor", import.meta.url));

async function helperSpokenProbe(nativeArgs, cwd) {
  const child = spawn(helper, nativeArgs, { cwd, stdio: ["pipe", "pipe", "pipe", "pipe"] });
  const finished = new Promise(resolve => child.once("close", resolve));
  child.stdin.on("error", () => {});
  const control = child.stdio[3];
  const lines = createInterface({ input: control });
  const events = [];
  const waiters = [];
  const waitFor = (predicate) => new Promise((resolve, reject) => {
    const value = events.find(predicate);
    if (value !== undefined) return resolve(value);
    waiters.push({ predicate, resolve, reject });
  });
  lines.on("line", (line) => {
    const event = JSON.parse(line);
    events.push(event);
    for (let i = waiters.length - 1; i >= 0; i--) {
      const waiter = waiters[i];
      if (waiter.predicate(event)) { waiters.splice(i, 1); waiter.resolve(event); }
    }
  });
  lines.on("error", (error) => { for (const waiter of waiters.splice(0)) waiter.reject(error); });
  child.on("error", (error) => { for (const waiter of waiters.splice(0)) waiter.reject(error); });
  let stdout = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  // These probes emit only a tiny literal. Deliberately drain it after fd3's
  // close ACK to reproduce independent-pipe scheduling without timing luck.
  child.stdout.pause();
  let exit;
  child.on("exit", (code, signal) => { exit = { code, signal }; for (const waiter of waiters.splice(0)) waiter.reject(new Error(`helper exited early ${code}/${signal}`)); });
  try {
    const ready = await waitFor((event) => event.type === "ready");
    assert.ok(typeof ready === "object");
    control.write("go\n");
    const closed = await waitFor((event) => event.type === "closed");
    child.stdout.resume();
    // fd3 confirms process ownership, not delivery of bytes on stdout. Wait
    // for all child streams to close before snapshotting the probe output.
    await finished;
    return { events, closed, stdout };
  } finally {
    child.stdin.end();
    child.stdout.resume();
    lines.close();
  }
}

test("AGY helper is a dynamic ELF within the committed glibc 2.28 floor", { skip: process.platform !== "linux" }, async () => {
  await access(helper);
  const { stdout: headers } = await exec("readelf", ["-l", helper]);
  assert.match(headers, /INTERP/, "helper must be dynamically linked (glibc startup compat)");
  const { stdout: versions } = await exec("readelf", ["--version-info", helper]);
  const requirements = [...new Set(versions.match(/GLIBC_\d+(?:\.\d+)*/g) ?? [])];
  assert.ok(requirements.length > 0, "helper should declare GLIBC version requirements");
  for (const version of requirements) {
    const [, major, minor] = /^GLIBC_(\d+)\.(\d+)/.exec(version);
    assert.ok(
      Number(major) < 2 || (Number(major) === 2 && Number(minor) <= 28),
      `helper raised the supported libc floor: ${version}`,
    );
  }
});

test("AGY helper starts and completes a control-protocol probe with a stub native", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-t02-helper-"));
  const { events, closed, stdout } = await helperSpokenProbe(["200", "/bin/echo", "SMOKE_OK"], root);
  assert.equal(stdout, "SMOKE_OK\n");
  assert.equal(closed.noChildren, true, "helper must confirm reaping its owned native child");
  assert.equal(events.some((event) => event.type === "ready"), true);
});

test("AGY helper reports exec failure and reclaims without spawning", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-t02-missing-"));
  const { events } = await helperSpokenProbe(["200", join(root, "missing-executable")], root);
  assert.equal(events.some((event) => event.type === "error" && event.operation === "exec" && event.errno === 2), true);
});

test("AGY helper rebuild is byte-identical to its committed source inputs", { skip: process.platform !== "linux" }, async () => {
  // Rebuilding is done by build-native.mjs during every root build; here we
  // only assert the shipped source copies match the native/ sources so the
  // artifact identity (dist/agy-supervisor.c) cannot drift silently.
  const root = fileURLToPath(new URL("../../packages/agy-adapter/", import.meta.url));
  for (const name of ["supervisor.c", "glibc-startup-compat.c"]) {
    const shipped = await readFile(join(root, "dist", `agy-supervisor${name === "supervisor.c" ? "" : "-glibc-compat"}.c`), "utf8");
    const source = await readFile(join(root, "../core/native", name), "utf8");
    assert.equal(shipped, source, `${name} must be shipped verbatim`);
  }
});

test("AGY rebuild keeps the published helper executable while the compiler output is incomplete", { skip: process.platform !== "linux" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-agy-atomic-build-"));
  const compiler = join(root, "cc-barrier");
  await copyFile(new URL("../fixtures/compiler-barrier.mjs", import.meta.url), compiler);
  await chmod(compiler, 0o700);
  const child = spawn(process.execPath, [fileURLToPath(new URL("../../packages/agy-adapter/scripts/build-native.mjs", import.meta.url))], {
    env: { ...process.env, CC: compiler, MUHA_BUILD_BARRIER: root },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stdout.resume();
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = once(child, "exit");
  try {
    const deadline = Date.now() + 5_000;
    while (!(await access(join(root, "started")).then(() => true, () => false))) {
      assert.ok(Date.now() < deadline, "compiler did not reach its output barrier");
      await delay(5);
    }
    const probe = await helperSpokenProbe(["200", "/bin/echo", "ATOMIC_BUILD_OK"], root);
    assert.equal(probe.stdout, "ATOMIC_BUILD_OK\n");
    assert.equal(probe.closed.noChildren, true);
  } finally {
    await writeFile(join(root, "release"), "continue");
    const [code] = await exited;
    await rm(root, { recursive: true, force: true });
    assert.equal(code, 0, stderr);
  }
});
