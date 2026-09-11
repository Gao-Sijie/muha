import { upsertServer } from "add-mcp";

import type { McpServerConfig } from "./runtime.js";

interface WorkerRequest {
  readonly workspacePath: string;
  readonly target: string;
  readonly server: McpServerConfig;
}

let input = "";
for await (const chunk of process.stdin) input += String(chunk);

try {
  const request = JSON.parse(input) as WorkerRequest;
  const succeeded = configureMcpServer(
    request.workspacePath,
    request.target,
    request.server,
  );
  process.exitCode = succeeded ? 0 : 1;
} catch {
  process.exitCode = 1;
}

function configureMcpServer(
  workspacePath: string,
  target: string,
  server: McpServerConfig,
): boolean {
  const nativeConfig = server.transport === "stdio"
    ? {
        command: server.command,
        ...(server.args === undefined ? {} : { args: [...server.args] }),
        ...(server.env === undefined ? {} : { env: { ...server.env } }),
      }
    : {
        type: "http" as const,
        url: server.url,
        ...(server.headers === undefined ? {} : { headers: { ...server.headers } }),
      };
  return upsertServer(target, server.name, nativeConfig, {
    local: true,
    cwd: workspacePath,
  }).success;
}
