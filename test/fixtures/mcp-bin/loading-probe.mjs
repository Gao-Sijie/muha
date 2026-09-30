import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const markerPath = process.env.MUHA_MCP_LOADING_MARKER;

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

const input = createInterface({ input: process.stdin });
for await (const line of input) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  if (request.method === "initialize") {
    respond(request.id, {
      protocolVersion: request.params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "muha-loading-probe", version: "1.0.0" },
    });
    continue;
  }
  if (request.method === "tools/list") {
    if (markerPath) await writeFile(markerPath, "loaded\n", { mode: 0o600 });
    respond(request.id, {
      tools: [{
        name: "loaded_probe",
        description: "Reports that the real Codex MCP client loaded this project server.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      }],
    });
    continue;
  }
  if (request.method === "ping") {
    respond(request.id, {});
    continue;
  }
  process.stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: request.id,
    error: { code: -32601, message: "Method not found" },
  })}\n`);
}
