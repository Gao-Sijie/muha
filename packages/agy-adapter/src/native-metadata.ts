import { constants } from "node:fs";
import { access, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { HarnessErrorData } from "@muha-sdk/core";
import { failure, object } from "./protocol.js";

// Private native format qualified in the metadata research. Never enumerate
// conversations, read transcripts, repair a DB, or maintain a Muha index.
export async function nativeBinding(env: NodeJS.ProcessEnv, id: string, workspace: string,
  operation: HarnessErrorData["operation"] = "resumeSession"): Promise<string> {
  const invalid = (detail: string): never => { throw failure(operation, `Unusable AGY Session metadata: ${detail}`); };
  if (!safeComponent(id)) invalid("invalid native identity");
  const home = env.HOME ?? homedir();
  const path = join(home, ".gemini/antigravity-cli/conversations", `${id}.db`);
  try { await access(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw {
      ...failure(operation, "AGY native Session does not exist"), nativeCode: "session_not_found",
    };
    invalid("cannot access native database");
  }
  let projectId: string;
  let workspaceUris: string[];
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout=0; PRAGMA query_only=ON; BEGIN");
      // Inspect lengths in a separate statement before SQLite materializes
      // values. substr alone would still load a corrupt oversized BLOB.
      const identitySizes = db.prepare("SELECT typeof(cascade_id) AS kind, octet_length(cascade_id) AS size FROM trajectory_meta LIMIT 2").all();
      const blobSizes = db.prepare("SELECT typeof(id) AS idKind, octet_length(id) AS idSize, typeof(data) AS kind, octet_length(data) AS size FROM trajectory_metadata_blob LIMIT 2").all();
      if (identitySizes.length !== 1 || identitySizes[0]!.kind !== "text" ||
        identitySizes[0]!.size !== Buffer.byteLength(id) ||
        blobSizes.length !== 1 || blobSizes[0]!.idKind !== "text" || blobSizes[0]!.idSize !== 4 ||
        blobSizes[0]!.kind !== "blob" || typeof blobSizes[0]!.size !== "number" || blobSizes[0]!.size > 1024 * 1024) {
        invalid("identity, metadata cardinality, or supported size bound");
      }
      const identities = db.prepare("SELECT cascade_id FROM trajectory_meta LIMIT 2").all();
      const blobs = db.prepare("SELECT id, data FROM trajectory_metadata_blob LIMIT 2").all();
      if (identities.length !== 1 || identities[0]!.cascade_id !== id || blobs.length !== 1 ||
        blobs[0]!.id !== "main" || !(blobs[0]!.data instanceof Uint8Array)) invalid("identity or metadata cardinality");
      const data = blobs[0]!.data as Uint8Array;
      if (blobSizes[0]!.size !== data.byteLength) invalid("metadata changed within its read snapshot");
      const fields = decodeFields(data);
      const projects = strings(fields, 18);
      workspaceUris = strings(fields, 7);
      if (projects.length !== 1 || !safeComponent(projects[0]!) || workspaceUris.length !== 1) invalid("Project or Workspace cardinality");
      projectId = projects[0]!;
      // Deprecated workspaces supply a consistency check only. Their git root
      // field is deliberately not treated as an additional Workspace.
      const legacy = fields.filter(field => field.number === 1);
      if (legacy.length) {
        if (legacy.length !== 1 || legacy[0]!.wire !== 2) invalid("legacy Workspace cardinality");
        const oldUris = strings(decodeFields(legacy[0]!.bytes!), 1);
        if (oldUris.length !== 1 || await directory(oldUris[0]!) !== await directory(workspaceUris[0]!)) invalid("conflicting Workspace metadata");
      }
      db.exec("COMMIT");
    } finally { db.close(); }
    const json = await readProject(join(home, ".gemini/config/projects", `${projectId!}.json`));
    const project = object(JSON.parse(json));
    const resources = object(project.projectResources).resources;
    if (project.id !== projectId! || !Array.isArray(resources) || resources.length !== 1) return invalid("Project identity or resources");
    const folderUri = object(resources[0]).folderUri;
    if (typeof folderUri !== "string") invalid("Project has no directory binding");
    if (await directory(folderUri as string) !== workspace || await directory(workspaceUris![0]!) !== workspace) {
      invalid("Session, Project, and requested Workspace disagree");
    }
    return projectId!;
  } catch { return invalid("unknown format, unreadable data, or conflicting Workspace binding"); }
}

async function readProject(path: string): Promise<string> {
  const limit = 1024 * 1024;
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > limit) throw new Error("Unsupported Project file");
    const buffer = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > limit) throw new Error("Project exceeds supported bound");
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
  } finally { await file.close(); }
}

function safeComponent(value: string): boolean {
  return value.length > 0 && value.length < 256 && value !== "." && value !== ".." && !/[\/\\\u0000-\u001f]/u.test(value);
}
async function directory(value: string): Promise<string> {
  const uri = new URL(value);
  if (uri.protocol !== "file:" || uri.hostname !== "" || uri.search || uri.hash) throw new Error("Nonlocal Workspace URI");
  const path = fileURLToPath(uri);
  if (path.includes("\0")) throw new Error("Invalid Workspace URI");
  return realpath(path);
}

interface Field { number: number; wire: number; bytes?: Uint8Array }
function decodeFields(data: Uint8Array): Field[] {
  let offset = 0;
  const varint = (): bigint => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      const byte = data[offset++];
      if (byte === undefined || (shift === 63n && byte > 1)) throw new Error("Invalid protobuf varint");
      value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return value;
    }
    throw new Error("Unterminated protobuf varint");
  };
  const fields: Field[] = [];
  while (offset < data.length) {
    const tag = varint();
    const number = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (number < 1 || number > 0x1fffffff) throw new Error("Invalid protobuf field");
    if (wire === 0) { varint(); fields.push({ number, wire }); continue; }
    const length = wire === 2 ? Number(varint()) : wire === 1 ? 8 : wire === 5 ? 4 : -1;
    if (!Number.isSafeInteger(length) || length < 0 || length > data.length - offset) throw new Error("Invalid protobuf length or wire type");
    fields.push({ number, wire, bytes: data.subarray(offset, offset + length) });
    offset += length;
  }
  return fields;
}
function strings(fields: readonly Field[], number: number): string[] {
  return fields.filter(field => field.number === number).map(field => {
    if (field.wire !== 2) throw new Error("Incorrect native field type");
    return new TextDecoder("utf-8", { fatal: true }).decode(field.bytes);
  });
}
