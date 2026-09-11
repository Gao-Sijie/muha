import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import type { McpServerConfig } from "./runtime.js";

const require = createRequire(import.meta.url);
const skillsCliPath = require.resolve("skills/bin/cli.mjs");
const mcpWorkerPath = fileURLToPath(new URL("./workspace-mcp-worker.js", import.meta.url));

export interface AdapterSkillConfigurationInput {
  readonly workspacePath: string;
  readonly source: string;
  readonly skillNames?: readonly [string, ...string[]];
}

export interface AdapterMcpConfigurationInput {
  readonly workspacePath: string;
  readonly server: McpServerConfig;
}

export interface WorkspaceWorkerInvocation {
  readonly entrypoint: string;
  readonly args: readonly string[];
  readonly stdin?: string;
}

export interface WorkspaceConfigurator {
  planSkill(input: AdapterSkillConfigurationInput): WorkspaceWorkerInvocation;
  planMcpServer(input: AdapterMcpConfigurationInput): WorkspaceWorkerInvocation;
}

export type WorkspaceSkillPlanner = WorkspaceConfigurator["planSkill"];
export type WorkspaceMcpPlanner = WorkspaceConfigurator["planMcpServer"];

export function composeWorkspaceConfigurator(
  planners: Readonly<{
    planSkill: WorkspaceSkillPlanner;
    planMcpServer: WorkspaceMcpPlanner;
  }>,
): WorkspaceConfigurator {
  return Object.freeze({
    planSkill: planners.planSkill,
    planMcpServer: planners.planMcpServer,
  });
}

export function createSkillsCliPlanner(agent: string): WorkspaceSkillPlanner {
  return (input) => Object.freeze({
    entrypoint: skillsCliPath,
    args: Object.freeze([
      "add",
      input.source,
      "--agent",
      agent,
      "--skill",
      ...(input.skillNames ?? ["*"]),
      "--copy",
      "--yes",
    ]),
  });
}

export function createAddMcpPlanner(target: string): WorkspaceMcpPlanner {
  return (input) => Object.freeze({
    entrypoint: mcpWorkerPath,
    args: Object.freeze([]),
    stdin: JSON.stringify({
      workspacePath: input.workspacePath,
      target,
      server: input.server,
    }),
  });
}
