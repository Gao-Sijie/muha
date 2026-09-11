import { chmod, mkdir, open as openFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { DataDirLockedErrorData, EventStoreErrorData } from "./errors.js";

const currentSchemaVersion = 1;
const databaseFilename = "diagnostic-events.sqlite";
const leaseFilename = `${databaseFilename}.lease`;
const schemaTables = Object.freeze([
  "core_event_records",
  "native_event_records",
  "runtime_instances",
]);

export class DiagnosticEventStore {
  readonly dataDir: string;
  readonly databasePath: string;
  readonly #database: DatabaseSync;
  readonly #lease: DatabaseSync;
  #closed = false;

  private constructor(
    dataDir: string,
    databasePath: string,
    database: DatabaseSync,
    lease: DatabaseSync,
  ) {
    this.dataDir = dataDir;
    this.databasePath = databasePath;
    this.#database = database;
    this.#lease = lease;
  }

  static async open(
    requestedDataDir: string,
    runtimeId: string,
  ): Promise<DiagnosticEventStore> {
    let database: DatabaseSync | undefined;
    let lease: DatabaseSync | undefined;
    try {
      await mkdir(requestedDataDir, { recursive: true, mode: 0o700 });
      const dataDir = await realpath(requestedDataDir);
      const databasePath = join(dataDir, databaseFilename);
      const leasePath = join(dataDir, leaseFilename);
      const sensitivePaths = [
        databasePath,
        `${databasePath}-journal`,
        `${databasePath}-wal`,
        `${databasePath}-shm`,
        leasePath,
        `${leasePath}-journal`,
      ];

      await assertSafeExistingFiles(sensitivePaths);
      await ensurePrivateFile(leasePath);
      lease = new DatabaseSync(leasePath);
      acquireLease(lease, dataDir);
      await chmod(leasePath, 0o600);

      // The lease closes the race between checking an existing database and
      // opening it. Re-check files that another former owner could have left.
      await assertSafeExistingFiles(sensitivePaths);
      await ensurePrivateFile(databasePath);
      database = new DatabaseSync(databasePath);
      database.exec(
        "PRAGMA busy_timeout = 0; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;",
      );
      assertIntegrity(database);
      migrateSchema(database);
      commitStatement(
        database,
        "INSERT INTO runtime_instances (runtime_id, started_at) VALUES (?, ?)",
        [runtimeId, new Date().toISOString()],
      );
      await protectSensitiveFiles(sensitivePaths);
      return new DiagnosticEventStore(dataDir, databasePath, database, lease);
    } catch (error) {
      try {
        database?.close();
      } catch {
        // The open failure remains authoritative.
      }
      try {
        lease?.close();
      } catch {
        // The open failure remains authoritative.
      }
      if (isDataDirLocked(error)) throw error;
      throw eventStoreFailure("open", error);
    }
  }

  recordNativeEvent(runtimeId: string, harness: string, payload: unknown): void {
    const payloadJson = serialize(payload);
    commitStatement(
      this.#database,
      `INSERT INTO native_event_records
        (runtime_id, harness, received_at, payload_json)
       VALUES (?, ?, ?, ?)`,
      [runtimeId, harness, new Date().toISOString(), payloadJson],
    );
  }

  recordCoreEvent(runtimeId: string, payload: unknown): void {
    const payloadJson = serialize(payload);
    commitStatement(
      this.#database,
      `INSERT INTO core_event_records
        (runtime_id, produced_at, payload_json) VALUES (?, ?, ?)`,
      [runtimeId, new Date().toISOString(), payloadJson],
    );
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    let failure: unknown;
    try {
      this.#database.close();
    } catch (error) {
      failure = error;
    }
    try {
      this.#lease.close();
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined) throw eventStoreFailure("close", failure);
  }
}

function acquireLease(database: DatabaseSync, dataDir: string): void {
  try {
    database.exec(`
      PRAGMA busy_timeout = 0;
      PRAGMA locking_mode = EXCLUSIVE;
      BEGIN EXCLUSIVE;
      CREATE TABLE IF NOT EXISTS lease_identity (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1)
      ) STRICT;
      COMMIT;
    `);
  } catch (error) {
    if (isSqliteLockFailure(error)) {
      throw {
        code: "DATA_DIR_LOCKED",
        message: "Diagnostic Event Store data directory is already owned",
        dataDir,
      } satisfies DataDirLockedErrorData;
    }
    throw error;
  }
}

function isSqliteLockFailure(error: unknown): boolean {
  return error instanceof Error && /database is (?:locked|busy)/i.test(error.message);
}

function isDataDirLocked(error: unknown): error is DataDirLockedErrorData {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "DATA_DIR_LOCKED";
}

function assertIntegrity(database: DatabaseSync): void {
  const rows = database.prepare("PRAGMA integrity_check").all() as readonly Record<string, unknown>[];
  if (
    rows.length !== 1 ||
    rows[0]?.integrity_check !== "ok"
  ) {
    throw new Error("SQLite integrity check failed");
  }
}

function migrateSchema(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    const version = readUserVersion(database);
    if (version > currentSchemaVersion) {
      throw new Error("Diagnostic Event Store schema is newer than this Muha version");
    }
    if (version === 0) {
      const existingTables = readTableNames(database);
      if (existingTables.length !== 0 && !sameStrings(existingTables, schemaTables)) {
        throw new Error("Diagnostic Event Store has an unsupported legacy schema");
      }
      database.exec(schemaSql);
      validateSchema(database);
      database.exec(`PRAGMA user_version = ${currentSchemaVersion}`);
    } else {
      validateSchema(database);
    }
    database.exec("COMMIT");
  } catch (error) {
    rollback(database);
    throw error;
  }
}

function validateSchema(database: DatabaseSync): void {
  if (!sameStrings(readTableNames(database), schemaTables)) {
    throw new Error("Diagnostic Event Store schema tables are invalid");
  }
  assertColumns(database, "runtime_instances", [
    ["runtime_id", "TEXT", 1, 1],
    ["started_at", "TEXT", 1, 0],
  ]);
  assertColumns(database, "native_event_records", [
    ["record_id", "INTEGER", 0, 1],
    ["runtime_id", "TEXT", 1, 0],
    ["harness", "TEXT", 1, 0],
    ["received_at", "TEXT", 1, 0],
    ["payload_json", "TEXT", 1, 0],
  ]);
  assertColumns(database, "core_event_records", [
    ["record_id", "INTEGER", 0, 1],
    ["runtime_id", "TEXT", 1, 0],
    ["produced_at", "TEXT", 1, 0],
    ["payload_json", "TEXT", 1, 0],
  ]);
  for (const table of schemaTables) assertStrictTable(database, table);
  assertRuntimeForeignKey(database, "native_event_records");
  assertRuntimeForeignKey(database, "core_event_records");
}

function assertColumns(
  database: DatabaseSync,
  table: string,
  expected: readonly (readonly [string, string, number, number])[],
): void {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as readonly Record<string, unknown>[];
  const actual = rows.map((row) => [row.name, row.type, row.notnull, row.pk]);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Diagnostic Event Store ${table} schema is invalid`);
  }
}

function assertStrictTable(database: DatabaseSync, table: string): void {
  const row = database
    .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(table) as Record<string, unknown> | undefined;
  if (typeof row?.sql !== "string" || !/\)\s*STRICT\s*$/i.test(row.sql)) {
    throw new Error(`Diagnostic Event Store ${table} is not STRICT`);
  }
}

function assertRuntimeForeignKey(database: DatabaseSync, table: string): void {
  const rows = database.prepare(`PRAGMA foreign_key_list(${table})`).all() as readonly Record<string, unknown>[];
  if (
    rows.length !== 1 ||
    rows[0]?.table !== "runtime_instances" ||
    rows[0]?.from !== "runtime_id" ||
    rows[0]?.to !== "runtime_id" ||
    rows[0]?.on_update !== "NO ACTION" ||
    rows[0]?.on_delete !== "NO ACTION"
  ) {
    throw new Error(`Diagnostic Event Store ${table} foreign key is invalid`);
  }
}

function readUserVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get() as Record<string, unknown> | undefined;
  const value = row?.user_version;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("Diagnostic Event Store schema version is invalid");
  }
  return value as number;
}

function readTableNames(database: DatabaseSync): string[] {
  return (database
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as unknown as readonly { name: string }[])
    .map(({ name }) => name);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function serialize(payload: unknown): string {
  try {
    const payloadJson = JSON.stringify(payload);
    if (payloadJson === undefined) throw new TypeError("event is not JSON serializable");
    return payloadJson;
  } catch (error) {
    throw eventStoreFailure("write", error);
  }
}

function commitStatement(
  database: DatabaseSync,
  statement: string,
  values: readonly (string | number | null)[],
): void {
  try {
    database.exec("BEGIN IMMEDIATE");
  } catch (error) {
    throw eventStoreFailure("commit", error);
  }
  try {
    database.prepare(statement).run(...values);
  } catch (error) {
    rollback(database);
    throw eventStoreFailure("write", error);
  }
  try {
    database.exec("COMMIT");
  } catch (error) {
    rollback(database);
    throw eventStoreFailure("commit", error);
  }
}

function rollback(database: DatabaseSync): void {
  try {
    database.exec("ROLLBACK");
  } catch {
    // The original transactional failure remains authoritative.
  }
}

async function ensurePrivateFile(path: string): Promise<void> {
  const handle = await openFile(path, "a", 0o600);
  await handle.close();
  await chmod(path, 0o600);
}

async function assertSafeExistingFiles(paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    let metadata;
    try {
      metadata = await stat(path);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error("Existing Diagnostic Event Store file has unsafe permissions");
    }
  }
}

async function protectSensitiveFiles(paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    try {
      await chmod(path, 0o600);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function eventStoreFailure(
  operation: EventStoreErrorData["operation"],
  error: unknown,
): EventStoreErrorData {
  if (isEventStoreError(error)) return error;
  const suffix = error instanceof Error ? `: ${error.message}` : "";
  return {
    code: "EVENT_STORE_ERROR",
    message: `Diagnostic Event Store ${operation} failed${suffix}`,
    operation,
  };
}

function isEventStoreError(error: unknown): error is EventStoreErrorData {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EVENT_STORE_ERROR"
  );
}

const schemaSql = `
  CREATE TABLE IF NOT EXISTS runtime_instances (
    runtime_id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS native_event_records (
    record_id INTEGER PRIMARY KEY,
    runtime_id TEXT NOT NULL,
    harness TEXT NOT NULL,
    received_at TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    FOREIGN KEY (runtime_id) REFERENCES runtime_instances(runtime_id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS core_event_records (
    record_id INTEGER PRIMARY KEY,
    runtime_id TEXT NOT NULL,
    produced_at TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    FOREIGN KEY (runtime_id) REFERENCES runtime_instances(runtime_id)
  ) STRICT;
`;
