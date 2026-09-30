import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import type { McpServerConfig } from "@muha-sdk/core";

type Request = { readonly workspacePath: string; readonly server: McpServerConfig };

let raw = "";
for await (const chunk of process.stdin) raw += String(chunk);
try {
  const request: unknown = JSON.parse(raw);
  if (!isRecord(request) || typeof request.workspacePath !== "string" ||
      !request.workspacePath.startsWith("/") || !isRecord(request.server)) {
    throw new Error("Invalid OpenCode v2 MCP request");
  }
  await configure(request as unknown as Request);
} catch {
  process.exitCode = 1;
}

async function configure(request: Request): Promise<void> {
  const jsonc = join(request.workspacePath, "opencode.jsonc");
  const json = join(request.workspacePath, "opencode.json");
  const jsoncInfo = await fileInfo(jsonc);
  const jsonInfo = await fileInfo(json);
  if (jsoncInfo && jsonInfo) throw new Error("Ambiguous OpenCode project configuration");
  const target = jsonInfo ? json : jsonc;
  const info = jsonInfo ?? jsoncInfo;
  if (info && typeof info.mode === "number" && (info.mode & 0o222) === 0) {
    throw new Error("OpenCode project configuration is read-only");
  }
  const original = info ? await readFile(target, "utf8") : "{}\n";
  const errors: ParseError[] = [];
  const document: unknown = parse(original, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isRecord(document) ||
      (document.mcp !== undefined && !isRecord(document.mcp)) ||
      (isRecord(document.mcp) && document.mcp.servers !== undefined &&
        !isRecord(document.mcp.servers))) {
    throw new Error("OpenCode project configuration is invalid");
  }
  const server = request.server;
  if (typeof server.name !== "string" || server.name.length === 0 ||
      ["__proto__", "prototype", "constructor"].includes(server.name)) {
    throw new Error("OpenCode MCP server name is invalid");
  }
  const native = server.transport === "stdio"
    ? { type: "local", command: [server.command, ...(server.args ?? [])],
        ...(server.env === undefined ? {} : { environment: server.env }) }
    : server.transport === "http"
      ? { type: "remote", url: server.url,
          ...(server.headers === undefined ? {} : { headers: server.headers, oauth: false }) }
      : undefined;
  if (!native) throw new Error("OpenCode MCP transport is unsupported");
  const edits = modify(original, ["mcp", "servers", server.name], native,
    { formattingOptions: { tabSize: 2, insertSpaces: true, eol: "\n" } });
  const next = applyEdits(original, edits);
  const nextErrors: ParseError[] = [];
  parse(next, nextErrors, { allowTrailingComma: true });
  if (nextErrors.length > 0) throw new Error("OpenCode MCP write would invalidate configuration");
  if (next === original) return;
  const temporary = join(request.workspacePath, `.muha-opencode-mcp-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, next, { flag: "wx",
      mode: info && typeof info.mode === "number" ? info.mode & 0o777 : 0o600 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function fileInfo(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("OpenCode config is not a regular file");
    return info;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
