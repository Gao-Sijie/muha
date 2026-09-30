import assert from "node:assert/strict";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createMuhaRuntime, MuhaError } from "@muha-sdk/core";
import { createOfficialHarnessRegistration } from "@muha-sdk/core/internal";
import { FULL_HARNESS_CAPABILITIES } from "../support/full-harness-capabilities.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const databaseFilename = "diagnostic-events.sqlite";

test("a supported legacy store migrates atomically and appends Runtime history", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-store-migration-"));
  const dataDir = join(root, "diagnostics");
  const databasePath = join(dataDir, databaseFilename);
  let first;
  let second;
  try {
    await mkdir(dataDir, { mode: 0o755 });
    createLegacyDatabase(databasePath);
    await chmod(databasePath, 0o600);

    first = await createMuhaRuntime({ harnesses: [inertRegistration()], dataDir });
    const firstRuntimeId = first.runtimeId;
    assert.equal((await stat(dataDir)).mode & 0o777, 0o755);
    await first.close();
    first = undefined;

    second = await createMuhaRuntime({ harnesses: [inertRegistration()], dataDir });
    const secondRuntimeId = second.runtimeId;
    await second.close();
    second = undefined;

    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(database.prepare("PRAGMA user_version").get().user_version, 1);
      assert.deepEqual(
        database
          .prepare("SELECT runtime_id FROM runtime_instances ORDER BY rowid")
          .all()
          .map(({ runtime_id }) => runtime_id),
        ["runtime-legacy", firstRuntimeId, secondRuntimeId],
      );
      assert.equal(
        database.prepare("SELECT payload_json FROM native_event_records").get().payload_json,
        '{"legacy":true}',
      );
    } finally {
      database.close();
    }
  } finally {
    await second?.close();
    await first?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("newer, malformed, corrupt, and unsafe stores are rejected without replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-store-rejection-"));
  try {
    const newer = join(root, "newer");
    await mkdir(newer, { mode: 0o700 });
    const newerPath = join(newer, databaseFilename);
    const newerDatabase = new DatabaseSync(newerPath);
    newerDatabase.exec("PRAGMA user_version = 2");
    newerDatabase.close();
    await chmod(newerPath, 0o600);
    await assertStoreOpenFailure(newer, /schema is newer/);
    const unchangedNewer = new DatabaseSync(newerPath, { readOnly: true });
    assert.equal(unchangedNewer.prepare("PRAGMA user_version").get().user_version, 2);
    assert.equal(
      unchangedNewer.prepare("SELECT count(*) AS count FROM sqlite_schema WHERE type = 'table'").get().count,
      0,
    );
    unchangedNewer.close();

    const malformed = join(root, "malformed");
    await mkdir(malformed, { mode: 0o700 });
    const malformedPath = join(malformed, databaseFilename);
    const malformedDatabase = new DatabaseSync(malformedPath);
    malformedDatabase.exec("CREATE TABLE runtime_instances (runtime_id TEXT PRIMARY KEY) STRICT");
    malformedDatabase.close();
    await chmod(malformedPath, 0o600);
    await assertStoreOpenFailure(malformed, /unsupported legacy schema|schema is invalid/);
    const unchangedMalformed = new DatabaseSync(malformedPath, { readOnly: true });
    assert.equal(unchangedMalformed.prepare("PRAGMA user_version").get().user_version, 0);
    assert.equal(
      unchangedMalformed.prepare("SELECT count(*) AS count FROM pragma_table_info('runtime_instances')").get().count,
      1,
    );
    unchangedMalformed.close();

    const corrupt = join(root, "corrupt");
    await mkdir(corrupt, { mode: 0o700 });
    const corruptPath = join(corrupt, databaseFilename);
    const corruptBytes = Buffer.from("not a sqlite database\0keep this evidence");
    await writeFile(corruptPath, corruptBytes, { mode: 0o600 });
    await assertStoreOpenFailure(corrupt, /file is not a database|integrity/);
    assert.deepEqual(await readFile(corruptPath), corruptBytes);

    const unsafe = join(root, "unsafe");
    await mkdir(unsafe, { mode: 0o700 });
    const unsafePath = join(unsafe, databaseFilename);
    createLegacyDatabase(unsafePath);
    await chmod(unsafePath, 0o644);
    await assertStoreOpenFailure(unsafe, /unsafe permissions/);
    assert.equal((await stat(unsafePath)).mode & 0o777, 0o644);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Muha-created Store directories and sensitive files use owner-only modes", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-store-permissions-"));
  const parent = join(root, "created-parent");
  const dataDir = join(parent, "created-runtime");
  let runtime;
  try {
    runtime = await createMuhaRuntime({ harnesses: [inertRegistration()], dataDir });
    assert.equal((await stat(parent)).mode & 0o777, 0o700);
    assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
    for (const filename of [
      databaseFilename,
      `${databaseFilename}-wal`,
      `${databaseFilename}-shm`,
      `${databaseFilename}.lease`,
    ]) {
      assert.equal((await stat(join(dataDir, filename))).mode & 0o777, 0o600, filename);
    }
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("one cross-process owner fails competitors promptly and crash recovery releases ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-store-owner-"));
  const dataDir = join(root, "diagnostics");
  const holder = spawn(
    process.execPath,
    ["--input-type=module", "--eval", childRuntimeProgram(true)],
    {
      cwd: repositoryRoot,
      env: { ...process.env, MUHA_TEST_DATA_DIR: dataDir },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let holderStderr = "";
  holder.stderr.setEncoding("utf8");
  holder.stderr.on("data", (chunk) => {
    holderStderr += chunk;
  });
  try {
    const held = JSON.parse(await readLine(holder.stdout));
    assert.equal(held.ready, true, holderStderr);

    const startedAt = performance.now();
    const blocked = runChildRuntime(dataDir);
    assert.ok(performance.now() - startedAt < 2_000);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.data.code, "DATA_DIR_LOCKED");
    assert.equal(blocked.data.dataDir, await realpath(dataDir));

    assert.equal(holder.kill("SIGKILL"), true);
    await once(holder, "exit");
    const recovered = runChildRuntime(dataDir);
    assert.equal(recovered.ok, true, recovered.stderr);

    const database = new DatabaseSync(join(dataDir, databaseFilename), { readOnly: true });
    try {
      assert.deepEqual(
        database
          .prepare("SELECT runtime_id FROM runtime_instances ORDER BY rowid")
          .all()
          .map(({ runtime_id }) => runtime_id),
        [held.runtimeId, recovered.runtimeId],
      );
      assert.equal(database.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    } finally {
      database.close();
    }
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) {
      holder.kill("SIGKILL");
      await once(holder, "exit");
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("a Store write failure fails all active Turns and fatally closes the Runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-store-fatal-"));
  const workspace = join(root, "workspace");
  let context;
  let runtime;
  const sessions = [];
  try {
    await mkdir(workspace);
    runtime = await createMuhaRuntime({
      harnesses: [controllableRegistration((value) => {
        context = value;
      })],
      dataDir: join(root, "diagnostics"),
    });
    await Promise.all([
      context.recordNativeEvent("codex", { inbound: 1 }),
      context.recordNativeEvent("codex", { inbound: 2 }),
    ]);
    const immediate = new DatabaseSync(join(runtime.dataDir, databaseFilename), { readOnly: true });
    assert.equal(
      immediate.prepare("SELECT count(*) AS count FROM native_event_records").get().count,
      2,
    );
    immediate.close();

    sessions.push(
      await runtime.createSession({ harness: "codex", workspacePath: workspace }),
      await runtime.createSession({ harness: "codex", workspacePath: workspace }),
    );
    const turns = await Promise.all(sessions.map((session) =>
      session.startTurn([{ type: "text", text: "hold" }])));
    const iterators = turns.map((turn) => turn[Symbol.asyncIterator]());
    for (const iterator of iterators) {
      assert.equal((await iterator.next()).value.type, "turn.started");
    }

    await assert.rejects(
      context.recordNativeEvent("codex", { impossible: 1n }),
      (error) => error.code === "EVENT_STORE_ERROR" && error.operation === "write",
    );
    const results = await Promise.all(turns.map(({ result }) => result));
    for (const result of results) {
      assert.equal(result.status, "failed");
      assert.equal(result.error.code, "EVENT_STORE_ERROR");
      assert.equal(result.error.operation, "write");
    }
    for (const iterator of iterators) {
      const terminal = (await iterator.next()).value;
      assert.equal(terminal.type, "turn.failed");
      assert.equal(terminal.error.code, "EVENT_STORE_ERROR");
      assert.equal((await iterator.next()).done, true);
    }

    const termination = await runtime.termination;
    assert.equal(termination.reason, "fatal");
    assert.equal(termination.error.code, "EVENT_STORE_ERROR");
    assert.equal(runtime.status, "closed");
    assert.deepEqual(sessions.map(({ status }) => status), [
      { status: "closed" },
      { status: "closed" },
    ]);
    await assert.rejects(
      runtime.createSession({ harness: "codex", workspacePath: workspace }),
      (error) => error instanceof MuhaError && error.data.code === "RUNTIME_CLOSED",
    );
    await runtime.close();
  } finally {
    await Promise.allSettled(sessions.map((session) => session.close()));
    await runtime?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("a SQLite commit failure rejects new commands and fatally closes the Runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "muha-store-commit-fatal-"));
  const workspace = join(root, "workspace");
  let context;
  let runtime;
  let blocker;
  try {
    await mkdir(workspace);
    runtime = await createMuhaRuntime({
      harnesses: [controllableRegistration((value) => {
        context = value;
      })],
      dataDir: join(root, "diagnostics"),
    });
    blocker = new DatabaseSync(join(runtime.dataDir, databaseFilename));
    blocker.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    await assert.rejects(
      context.recordNativeEvent("codex", { cannotCommit: true }),
      (error) => error.code === "EVENT_STORE_ERROR" && error.operation === "commit",
    );
    assert.notEqual(runtime.status, "active");
    await assert.rejects(
      runtime.createSession({ harness: "codex", workspacePath: workspace }),
      (error) => error instanceof MuhaError && error.data.code === "RUNTIME_CLOSED",
    );
    blocker.exec("ROLLBACK");
    blocker.close();
    blocker = undefined;
    const termination = await runtime.termination;
    assert.equal(termination.reason, "fatal");
    assert.equal(termination.error.operation, "commit");
  } finally {
    try {
      blocker?.exec("ROLLBACK");
    } catch {
      // Best-effort release of the temporary test lock.
    }
    blocker?.close();
    await runtime?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

function inertRegistration() {
  return createOfficialHarnessRegistration(
    "codex",
    {},
    FULL_HARNESS_CAPABILITIES,
    unusedWorkspaceConfigurator,
    () => ({
    kind: "codex",
    async initialize() {},
    async createSession() {
      throw new Error("not used");
    },
    async resumeSession() {
      throw new Error("not used");
    },
    async listSessions() {
      return [];
    },
    async close() {},
    }),
  );
}

function controllableRegistration(captureContext) {
  let nextSessionId = 1;
  return createOfficialHarnessRegistration(
    "codex",
    {},
    FULL_HARNESS_CAPABILITIES,
    unusedWorkspaceConfigurator,
    (_options, context) => {
    captureContext(context);
    return {
      kind: "codex",
      async initialize() {},
      async createSession() {
        return controlledSession(context, nextSessionId++);
      },
      async resumeSession() {
        throw new Error("not used");
      },
      async listSessions() {
        return [];
      },
      async close() {},
    };
    },
  );
}

const unusedWorkspaceConfigurator = Object.freeze({
  planSkill: unusedPlan,
  planMcpServer: unusedPlan,
});

function unusedPlan() {
  return Object.freeze({ entrypoint: "/unused.js", args: Object.freeze([]) });
}

function controlledSession(context, sessionId) {
  const releases = new Set();
  return {
    nativeSessionId: `controlled-${sessionId}`,
    model: undefined,
    async startTurn() {
      let release;
      const held = new Promise((resolveHeld) => {
        release = resolveHeld;
      });
      releases.add(release);
      return {
        nativeTurnId: `controlled-turn-${sessionId}`,
        async *[Symbol.asyncIterator]() {
          await context.recordNativeEvent("codex", {
            method: "controlled/turnStarted",
            params: { sessionId },
          });
          yield { type: "turn.started" };
          await held;
        },
        async interrupt() {
          release();
        },
        async respondToApproval() {
          throw new Error("not used");
        },
      };
    },
    async setModel() {},
    async close() {
      for (const release of releases) release();
      releases.clear();
    },
  };
}

function createLegacyDatabase(path) {
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE runtime_instances (
      runtime_id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE native_event_records (
      record_id INTEGER PRIMARY KEY,
      runtime_id TEXT NOT NULL,
      harness TEXT NOT NULL,
      received_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      FOREIGN KEY (runtime_id) REFERENCES runtime_instances(runtime_id)
    ) STRICT;
    CREATE TABLE core_event_records (
      record_id INTEGER PRIMARY KEY,
      runtime_id TEXT NOT NULL,
      produced_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      FOREIGN KEY (runtime_id) REFERENCES runtime_instances(runtime_id)
    ) STRICT;
    INSERT INTO runtime_instances VALUES ('runtime-legacy', '2000-01-01T00:00:00.000Z');
    INSERT INTO native_event_records
      (runtime_id, harness, received_at, payload_json)
      VALUES ('runtime-legacy', 'codex', '2000-01-01T00:00:01.000Z', '{"legacy":true}');
  `);
  database.close();
}

async function assertStoreOpenFailure(dataDir, messagePattern) {
  await assert.rejects(
    createMuhaRuntime({ harnesses: [inertRegistration()], dataDir }),
    (error) => {
      assert.ok(error instanceof MuhaError);
      assert.equal(error.data.code, "RUNTIME_INITIALIZATION_FAILED");
      const failure = error.data.initializationFailures[0];
      assert.equal(failure.code, "EVENT_STORE_ERROR");
      assert.equal(failure.operation, "open");
      assert.match(failure.message, messagePattern);
      return true;
    },
  );
}

function childRuntimeProgram(hold) {
  return `
    import { createMuhaRuntime } from "@muha-sdk/core";
    import { createOfficialHarnessRegistration } from "@muha-sdk/core/internal";
    const workspaceConfigurator = Object.freeze({
      planSkill: () => Object.freeze({ entrypoint: "/unused.js", args: Object.freeze([]) }),
      planMcpServer: () => Object.freeze({ entrypoint: "/unused.js", args: Object.freeze([]) }),
    });
    function deepFreeze(value) {
      for (const nested of Object.values(value)) {
        if (nested !== null && typeof nested === "object") deepFreeze(nested);
      }
      return Object.freeze(value);
    }
    const registration = createOfficialHarnessRegistration(
      "codex",
      {},
      deepFreeze(${JSON.stringify(FULL_HARNESS_CAPABILITIES)}),
      workspaceConfigurator,
      () => ({
      kind: "codex",
      async initialize() {},
      async createSession() { throw new Error("not used"); },
      async resumeSession() { throw new Error("not used"); },
      async listSessions() { return []; },
      async close() {},
      }),
    );
    try {
      const runtime = await createMuhaRuntime({
        harnesses: [registration],
        dataDir: process.env.MUHA_TEST_DATA_DIR,
      });
      process.stdout.write(JSON.stringify({
        ok: true,
        ready: true,
        runtimeId: runtime.runtimeId,
      }) + "\\n");
      ${hold ? "setInterval(() => undefined, 1000);" : "await runtime.close();"}
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, data: error.data }) + "\\n");
    }
  `;
}

function runChildRuntime(dataDir) {
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", childRuntimeProgram(false)],
    {
      cwd: repositoryRoot,
      env: { ...process.env, MUHA_TEST_DATA_DIR: dataDir },
      encoding: "utf8",
      timeout: 5_000,
    },
  );
  assert.equal(child.status, 0, child.stderr);
  return { ...JSON.parse(child.stdout.trim()), stderr: child.stderr };
}

function readLine(stream) {
  stream.setEncoding("utf8");
  return new Promise((resolveLine, rejectLine) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      cleanup();
      resolveLine(buffer.slice(0, newline));
    };
    const onEnd = () => {
      cleanup();
      rejectLine(new Error("child exited before readiness"));
    };
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("end", onEnd);
    };
    stream.on("data", onData);
    stream.on("end", onEnd);
  });
}
