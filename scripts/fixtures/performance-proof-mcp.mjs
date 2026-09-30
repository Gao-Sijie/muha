// Local test fixture, not a provider substitute: paid Harness Turns must invoke
// this real MCP server through their native Workspace configuration.
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const receipt = process.argv[2];
if (!receipt) throw new Error("An explicit local receipt path is required");
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result, error;
  switch (request.method) {
    case "initialize":
      result = { protocolVersion: request.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} }, serverInfo: { name: "muha-pf-proof", version: "1.0.0" } };
      break;
    case "ping": result = {}; break;
    case "tools/list":
      result = { tools: [{ name: "proof", description: "Return a newly generated Muha qualification proof code.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false } }] };
      break;
    case "tools/call": {
      if (request.params?.name !== "proof") { error = { code: -32602, message: "Unknown tool" }; break; }
      const proof = `MUHA_MCP_${randomUUID().replaceAll("-", "")}`;
      appendFileSync(receipt, `${JSON.stringify({ proof, tool: "proof" })}\n`, { mode: 0o600 });
      result = { content: [{ type: "text", text: proof }] };
      break;
    }
    case "resources/list": result = { resources: [] }; break;
    case "prompts/list": result = { prompts: [] }; break;
    default: error = { code: -32601, message: "Method not found" };
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, ...(error ? { error } : { result }) })}\n`);
}
