import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, readlink, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

// D02 research only: no AGY/model invocation, production registration, system
// configuration, compiler, or host process lifecycle changes. Python supplies
// literal fork/setsid fixtures and a reaping namespace init. This does not
// decide whether a production init adds Python or a distributed native helper.
const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "muha-agy-ownership-"));
const fixturePath = join(root, "workload.py");
const marker = "muha ownership: 空格 $literal `literal` \"quoted\"";
const report = { kind: "agy-owned-process-research", root, checks: [], cases: [] };
const hostBefore = hostState();
let outsider;
let active;

const fixture = String.raw`
import hashlib, json, math, os, select, signal, sys, time

role, directory = sys.argv[1:3]
deadline = time.monotonic() + 10
os.makedirs(directory, exist_ok=True)

def record(kind, **fields):
    data = json.dumps(dict(kind=kind, pid=os.getpid(), pgid=os.getpgrp(), **fields), separators=(',', ':')) + '\n'
    fd = os.open(os.path.join(directory, 'events.jsonl'), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        os.write(fd, data.encode())
    finally:
        os.close(fd)

def expired(_sig=None, _frame=None):
    os._exit(70)

def guard():
    signal.signal(signal.SIGALRM, expired)
    signal.alarm(max(1, math.ceil(deadline - time.monotonic())))

def worker(name, mode='ordinary'):
    guard()
    if mode == 'setsid':
        os.setsid()
    elif mode == 'process-group':
        os.setpgid(0, 0)
    spawned = False
    def stopping(_sig, _frame):
        nonlocal spawned
        if name == 'late-fork' and not spawned:
            spawned = True
            for index in range(3):
                if os.fork() == 0:
                    worker('after-term-' + str(index), 'setsid')
    signal.signal(signal.SIGTERM, stopping)
    signal.signal(signal.SIGUSR1, signal.SIG_IGN)
    record('worker-ready', name=name)
    path = os.path.join(directory, 'writes-' + str(os.getpid()))
    while time.monotonic() < deadline:
        with open(path, 'ab', buffering=0) as output:
            output.write(b'x')
        time.sleep(0.02)
    os._exit(0)

if role == 'outsider':
    worker('unrelated-same-user')

guard()
assert os.getpid() == 1, 'The helper must be the PID namespace init'
environment = json.dumps(sorted(os.environ.items()), ensure_ascii=False, separators=(',', ':')).encode()
snapshot = dict(cwd=os.getcwd(), uid=os.getuid(), gid=os.getgid(), groups=os.getgroups(),
                environmentHash=hashlib.sha256(environment).hexdigest(),
                pidNamespace=os.readlink('/proc/self/ns/pid'),
                userNamespace=os.readlink('/proc/self/ns/user'),
                mountNamespace=os.readlink('/proc/self/ns/mnt'),
                capEff=next(line.split()[1] for line in open('/proc/self/status') if line.startswith('CapEff:')),
                readableNativePaths=[os.access(path, os.R_OK) for path in json.loads(sys.argv[3])],
                nativeFileHashes=[hashlib.sha256(open(path, 'rb').read()).hexdigest() for path in json.loads(sys.argv[4])],
                groupAccess=[os.access(path, os.R_OK | os.W_OK) for path in json.loads(sys.argv[5])],
                removedEnvironmentAbsent='MUHA_OWNERSHIP_REMOVED' not in os.environ)
with open(os.path.join(directory, 'snapshot.json'), 'w') as output:
    json.dump(snapshot, output)
with open(os.path.join(directory, 'helper-ready'), 'w') as output:
    output.write('ready')
# Never start the native workload until the live consumer accepts ownership.
# This also exits on control EOF if unshare died before arming PDEATHSIG.
if sys.stdin.readline() != 'go\n':
    record('startup-cancelled')
    os._exit(0)
cli = os.fork()
if cli == 0:
    guard()
    signal.signal(signal.SIGUSR1, lambda _sig, _frame: os._exit(0))
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    for name, mode in [('separate-group', 'process-group'), ('detached', 'setsid'), ('late-fork', 'setsid')]:
        if os.fork() == 0:
            worker(name, mode)
    intermediate = os.fork()
    if intermediate == 0:
        os.setsid()
        if os.fork() == 0:
            worker('double-fork', 'setsid')
        os._exit(0)
    os.waitpid(intermediate, 0)
    while time.monotonic() < deadline:
        try:
            events = [json.loads(line) for line in open(os.path.join(directory, 'events.jsonl'))]
            if len([event for event in events if event['kind'] == 'worker-ready']) >= 4:
                break
        except FileNotFoundError:
            pass
        time.sleep(0.005)
    with open(os.path.join(directory, 'ready'), 'w') as output:
        output.write('ready')
    record('cli-ready')
    while True:
        time.sleep(0.01)

signal.signal(signal.SIGTERM, lambda _sig, _frame: os._exit(0))
print('stdout:' + os.environ['MUHA_OWNERSHIP_MARKER'], flush=True)
print('stderr:' + os.environ['MUHA_OWNERSHIP_MARKER'], file=sys.stderr, flush=True)
while time.monotonic() < deadline:
    while True:
        exited, _status = os.waitpid(-1, os.WNOHANG)
        if exited == cli:
            record('helper-observed-cli-exit')
            os._exit(0)
        if not exited:
            break
    readable, _, _ = select.select([sys.stdin], [], [], 0.01)
    if not readable:
        continue
    line = sys.stdin.readline()
    if not line:
        record('control-eof')
        os._exit(0)
    command = line.rstrip('\n')
    if command.startswith('echo:'):
        print(command, flush=True)
    elif command == 'normal-exit':
        os.kill(cli, signal.SIGUSR1)
    elif command == 'kill-cli':
        os.kill(cli, signal.SIGKILL)
    elif command == 'stop':
        record('stop-started')
        # kill(-1) is confined to this fresh PID namespace; PID1 is excluded.
        os.kill(-1, signal.SIGTERM)
        time.sleep(0.2)
        # Exiting namespace init invokes kernel termination of the whole tree,
        # including processes forked during the graceful interval.
        os._exit(0)
    else:
        raise RuntimeError('Unknown synthetic control command')
expired()
`;

try {
  await writeFile(fixturePath, fixture, { mode: 0o600 });
  const { stdout: version } = await exec("unshare", ["--version"], { timeout: 2000 });
  report.unshare = version.trim();
  const flags = ["--map-current-user", "--pid", "--fork", "--kill-child=SIGKILL", "--mount-proc"];
  await exec("unshare", [...flags, "/bin/true"], { timeout: 2000 });
  report.checks.push("unprivileged-user-pid-mount-namespaces-available");
  const nativePaths = [join(homedir(), ".gemini/antigravity-cli"), join(homedir(), ".gemini/config/projects")];
  const readableBefore = await Promise.all(nativePaths.map(async path => access(path).then(() => true, () => false)));
  const nativeFiles = [];
  for (const name of ["settings.json", "antigravity-oauth-token"]) {
    const path = join(homedir(), ".gemini/antigravity-cli", name);
    if (await access(path, constants.R_OK).then(() => true, () => false)) nativeFiles.push(path);
  }
  const groupPaths = [];
  for (const path of ["/var/run/docker.sock", "/dev/ttyS0"]) {
    try {
      const metadata = await stat(path);
      if (metadata.uid !== process.getuid() && process.getgroups().includes(metadata.gid) && (metadata.mode & 0o066) === 0o060 &&
        await access(path, constants.R_OK | constants.W_OK).then(() => true, () => false)) groupPaths.push(path);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  report.groupAccessFixtureCount = groupPaths.length;
  report.nativeFileReadFixtureCount = nativeFiles.length;
  const childEnvironment = { ...process.env, MUHA_OWNERSHIP_MARKER: marker };
  delete childEnvironment.MUHA_OWNERSHIP_REMOVED;
  const expectedHash = createHash("sha256").update(JSON.stringify(Object.entries(childEnvironment).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))).digest("hex");
  const outsiderDirectory = join(root, "unrelated");
  outsider = tracked(spawn("python3", [fixturePath, "outsider", outsiderDirectory], { stdio: "ignore" }));
  await waitFor(async () => (await writes(outsiderDirectory)) > 0, "unrelated writer startup");
  for (const mode of ["normal-exit", "kill-cli", "kill-helper", "kill-wrapper", "control-eof", "stop", "startup-missed-pdeath"]) {
    const directory = join(root, mode);
    await mkdir(directory);
    const nativeFileHashes = await Promise.all(nativeFiles.map(async path => createHash("sha256").update(await readFile(path)).digest("hex")));
    // Omitting PDEATHSIG deterministically represents a wrapper which died
    // before unshare's post-fork prctl. The private GO/EOF gate must suffice.
    const startupLoss = mode === "startup-missed-pdeath";
    const caseFlags = startupLoss ? flags.filter(flag => !flag.startsWith("--kill-child")) : flags;
    active = tracked(spawn("unshare", [...caseFlags, "python3", fixturePath, "helper", directory, JSON.stringify(nativePaths), JSON.stringify(nativeFiles), JSON.stringify(groupPaths)], {
      cwd: directory, env: childEnvironment, stdio: ["pipe", "pipe", "pipe"],
    }));
    active.child.stdout.setEncoding("utf8");
    active.child.stderr.setEncoding("utf8");
    let stdout = "", stderr = "";
    active.child.stdout.on("data", text => { stdout += text; });
    active.child.stderr.on("data", text => { stderr += text; });
    await waitFor(async () => access(join(directory, "helper-ready")).then(() => true, () => false), `${mode}: helper startup`);
    const snapshot = JSON.parse(await readFile(join(directory, "snapshot.json"), "utf8"));
    assert.equal(snapshot.cwd, directory);
    assert.equal(snapshot.uid, process.getuid());
    assert.equal(snapshot.gid, process.getgid());
    // Supplementary kernel groups are retained but IDs outside the one-entry
    // user namespace gid_map are presented as overflowgid (usually 65534).
    // This is a compatibility cost, not evidence that getgroups is unchanged.
    assert.equal(snapshot.groups.length, process.getgroups().length);
    assert.deepEqual(snapshot.groupAccess, groupPaths.map(() => true));
    assert.equal(snapshot.environmentHash, expectedHash);
    assert.equal(snapshot.removedEnvironmentAbsent, true);
    assert.deepEqual(snapshot.readableNativePaths, readableBefore);
    assert.deepEqual(snapshot.nativeFileHashes, nativeFileHashes, "Existing settings/login bytes must remain readable unchanged");
    assert.equal(snapshot.capEff, "0000000000000000", "The workload must not retain namespace capabilities");
    assert.notEqual(snapshot.pidNamespace, await readlink("/proc/self/ns/pid"));
    assert.notEqual(snapshot.userNamespace, await readlink("/proc/self/ns/user"));
    assert.notEqual(snapshot.mountNamespace, await readlink("/proc/self/ns/mnt"));
    if (!startupLoss) {
      active.child.stdin.write("go\n");
      await waitFor(async () => access(join(directory, "ready")).then(() => true, () => false), `${mode}: workload startup`);
      active.child.stdin.write(`echo:${marker}\n`);
      await waitFor(async () => stdout.includes(`echo:${marker}\n`), `${mode}: stdin/stdout roundtrip`);
      assert.ok(stdout.includes(`stdout:${marker}\n`));
      assert.ok(stderr.includes(`stderr:${marker}\n`));
      const before = await events(directory);
      assert.equal(before.filter(event => event.kind === "worker-ready").length, 4);
      assert.ok(before.filter(event => event.kind === "worker-ready").every(event => event.pid === event.pgid));
    }
    // Discovering the namespace init only serves fault injection. Ownership and
    // cleanup use the kernel namespace, never a /proc tree walk or PID snapshot.
    const children = (await readFile(`/proc/${active.child.pid}/task/${active.child.pid}/children`, "utf8")).trim().split(/\s+/).filter(Boolean).map(Number);
    assert.equal(children.length, 1);
    const helperPid = children[0];
    assert.equal(await readlink(`/proc/${helperPid}/ns/pid`), snapshot.pidNamespace);
    const outsiderBefore = await writes(outsiderDirectory);
    const started = performance.now();
    if (startupLoss) { active.child.kill("SIGKILL"); active.child.stdin.end(); }
    else if (mode === "kill-helper") process.kill(helperPid, "SIGKILL");
    else if (mode === "kill-wrapper") active.child.kill("SIGKILL");
    else if (mode === "control-eof") active.child.stdin.end();
    else active.child.stdin.write(`${mode}\n`);
    await waitFor(async () => active.exited, `${mode}: owned wrapper exit`, 1500);
    // A wrapper SIGKILL does not wait for its child. Wait for kernel namespace
    // teardown as external evidence; never signal identities found here.
    await waitFor(async () => (await liveNamespaceMembers(snapshot.pidNamespace)).length === 0, `${mode}: namespace empty`, Math.max(1, 1500 - (performance.now() - started)));
    const stoppedAt = performance.now();
    assert.ok(stoppedAt - started < 1500, `${mode}: total cleanup exceeded 1500 ms`);
    const stoppedWrites = await writes(directory);
    await delay(120);
    assert.equal(await writes(directory), stoppedWrites, `${mode}: owned writes continued after cleanup`);
    assert.ok(await writes(outsiderDirectory) > outsiderBefore, `${mode}: unrelated process stopped`);
    const after = await events(directory);
    if (startupLoss) {
      assert.equal(after.filter(event => ["cli-ready", "worker-ready"].includes(event.kind)).length, 0);
      assert.ok(after.some(event => event.kind === "startup-cancelled"));
      assert.equal(stoppedWrites, 0);
    }
    if (mode === "stop") {
      const stopIndex = after.findIndex(event => event.kind === "stop-started");
      assert.ok(stopIndex >= 0);
      assert.equal(after.slice(stopIndex + 1).filter(event => event.kind === "worker-ready" && event.name.startsWith("after-term-")).length, 3);
    }
    report.cases.push({ mode, cleanupMs: Math.round(stoppedAt - started), lateForks: after.filter(event => event.name?.startsWith("after-term-")).length,
      supplementaryGroupDisplayChanged: JSON.stringify([...snapshot.groups].sort()) !== JSON.stringify([...process.getgroups()].sort()),
      ownWritesStopped: true, unrelatedWriterAlive: true, exit: active.result });
    active = undefined;
  }
  assert.deepEqual(hostState(), hostBefore);
  report.checks.push("literal-setsid-independent-pgid-double-fork-fast-parent-exit", "cli-normal-exit-and-sigkill",
    "namespace-init-loss-and-unshare-wrapper-loss", "control-eof", "fork-during-graceful-stop",
    "startup-go-gate-prevents-native-spawn-when-parent-death-signal-is-missed",
    "same-user-unrelated-process-unaffected", "cwd-uid-gid-env-stdio-preserved", "native-directories-readable", "existing-settings-and-login-bytes-readable",
    "no-effective-workload-capabilities", "host-cwd-env-and-signal-listeners-unchanged");
  report.status = "synthetic-proof-passed-native-agy-not-qualified";
} catch (error) {
  report.status = "failed";
  report.failure = { name: error.name, message: error.message };
  process.exitCode = 1;
} finally {
  // Only direct, still-running fixture children are signalled. All fixture
  // descendants have a separate ten-second self-termination guard.
  active?.child.stdin?.end();
  if (active && !active.exited) active.child.kill("SIGKILL");
  if (outsider && !outsider.exited) outsider.child.kill("SIGKILL");
  await Promise.all([active?.completion, outsider?.completion]);
  await writeFile(join(root, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function tracked(child) {
  const state = { child, exited: false };
  child.stdin?.on("error", error => { state.inputError = error.code; });
  state.completion = new Promise(resolve => {
    child.once("exit", (code, signal) => { state.exited = true; state.result = { code, signal }; resolve(); });
    child.once("error", error => { state.exited = true; state.result = { error: error.code }; resolve(); });
  });
  return state;
}
function hostState() {
  return { cwd: process.cwd(), environmentHash: createHash("sha256").update(JSON.stringify(process.env)).digest("hex"), uid: process.getuid(), gid: process.getgid(), groups: process.getgroups(),
    signals: Object.fromEntries(["SIGINT", "SIGTERM", "beforeExit", "uncaughtException", "unhandledRejection"].map(name => [name, process.listenerCount(name)])) };
}
async function waitFor(check, label, bound = 2000) {
  const deadline = performance.now() + bound;
  do { if (await check()) return; await delay(10); } while (performance.now() < deadline);
  throw new Error(`${label} exceeded ${bound} ms`);
}
async function writes(directory) {
  try { return (await Promise.all((await readdir(directory)).filter(name => name.startsWith("writes-")).map(async name => (await stat(join(directory, name))).size))).reduce((sum, size) => sum + size, 0); }
  catch (error) { if (error.code === "ENOENT") return 0; throw error; }
}
async function events(directory) {
  return (await readFile(join(directory, "events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
}
async function liveNamespaceMembers(namespace) {
  const members = [];
  for (const name of (await readdir("/proc")).filter(name => /^\d+$/.test(name))) {
    try {
      if (await readlink(`/proc/${name}/ns/pid`) !== namespace) continue;
      if (!/^\d+ \(.*\) Z /.test(await readFile(`/proc/${name}/stat`, "utf8"))) members.push(Number(name));
    } catch (error) { if (!["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(error.code)) throw error; }
  }
  return members;
}
