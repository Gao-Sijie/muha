import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { AdapterMcpConfigurationInput } from "@muha-sdk/core/internal";

let input = "";
for await (const chunk of process.stdin) input += String(chunk);

try {
  const request = JSON.parse(input) as AdapterMcpConfigurationInput;
  const succeeded = upsertKimiMcpServer(request.workspacePath, request.server);
  process.exitCode = succeeded ? 0 : 1;
} catch {
  process.exitCode = 1;
}

function upsertKimiMcpServer(
  workspacePath: string,
  server: AdapterMcpConfigurationInput["server"],
): boolean {
  const path = join(workspacePath, ".kimi-code", "mcp.json");
  try {
    const config = readConfig(path);
    const existing = config.mcpServers;
    if (existing !== undefined && !isPlainRecord(existing)) return false;
    const native = server.transport === "stdio"
      ? {
          transport: "stdio" as const,
          command: server.command,
          ...(server.args === undefined ? {} : { args: [...server.args] }),
          ...(server.env === undefined ? {} : { env: { ...server.env } }),
        }
      : {
          transport: "http" as const,
          url: server.url,
          ...(server.headers === undefined ? {} : { headers: { ...server.headers } }),
        };
    const next = {
      ...config,
      mcpServers: {
        ...(existing ?? {}),
        [server.name]: native,
      },
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

function readConfig(path: string): Record<string, unknown> {
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return {};
    throw error;
  }
  if (source.trim().length === 0) return {};
  const value = JSON.parse(source) as unknown;
  if (!isPlainRecord(value)) throw new Error("Kimi MCP config must be an object");
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
