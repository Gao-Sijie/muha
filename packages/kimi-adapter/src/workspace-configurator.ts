import { fileURLToPath } from "node:url";

import type {
  WorkspaceMcpPlanner,
  WorkspaceWorkerInvocation,
} from "@muha-sdk/core/internal";

const kimiMcpWorkerPath = fileURLToPath(
  new URL("./workspace-mcp-worker.js", import.meta.url),
);

export const planKimiMcpServer: WorkspaceMcpPlanner = (input) => {
  const invocation: WorkspaceWorkerInvocation = {
    entrypoint: kimiMcpWorkerPath,
    args: Object.freeze([]),
    stdin: JSON.stringify({
      workspacePath: input.workspacePath,
      server: input.server,
    }),
  };
  return Object.freeze(invocation);
};
