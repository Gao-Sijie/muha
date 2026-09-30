import { realpath } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";

function protocol(message) { return Object.assign(new Error(message), { protocolError: true }); }
function timestamp(value) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw protocol("Pi returned an invalid Session timestamp");
  return value.toISOString();
}

async function validateIdentity(id, cwd, workspacePath) {
  if (typeof id !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id)) {
    throw protocol("Pi returned an invalid native Session ID");
  }
  if (typeof cwd !== "string" || !isAbsolute(cwd)) throw protocol("Pi returned an invalid Session Workspace");
  let canonical;
  try { canonical = await realpath(cwd); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    canonical = normalize(cwd);
  }
  if (canonical !== workspacePath) throw protocol("Pi Session belongs to a different Workspace");
}

export async function listNativeSessions(sdk, workspacePath, diagnostic) {
  const sessions = await sdk.SessionManager.list(workspacePath);
  await diagnostic?.("SessionManager.list", sessions);
  const ids = new Set();
  for (const session of sessions) {
    await validateIdentity(session.id, session.cwd, workspacePath);
    if (ids.has(session.id)) throw protocol("Pi returned duplicate native Session IDs");
    ids.add(session.id);
  }
  return sessions;
}

export async function listedSessions(sdk, workspacePath, diagnostic) {
  return (await listNativeSessions(sdk, workspacePath, diagnostic)).map(session => ({
    nativeSessionId: session.id, workspacePath,
    ...(session.name === undefined ? {} : { title: session.name }),
    createdAt: timestamp(session.created), updatedAt: timestamp(session.modified),
  }));
}

export async function openNativeSession(sdk, options, diagnostic) {
  const native = (await listNativeSessions(sdk, options.workspacePath, diagnostic))
    .find(entry => entry.id === options.nativeSessionId);
  if (!native) throw Object.assign(new Error("Pi native Session was not found"), { nativeCode: "session_not_found" });
  const manager = sdk.SessionManager.open(native.path);
  await validateIdentity(manager.getSessionId(), manager.getCwd(), options.workspacePath);
  if (manager.getSessionId() !== options.nativeSessionId) throw protocol("Pi resumed a different Session");
  return manager;
}
