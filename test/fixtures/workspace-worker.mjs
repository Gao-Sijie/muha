import { appendFileSync } from "node:fs";

let input = "";
for await (const chunk of process.stdin) input += String(chunk);

const request = JSON.parse(input);
appendFileSync(request.outputPath, `${JSON.stringify({
  label: request.label,
  cwd: process.cwd(),
  disableTelemetry: process.env.DISABLE_TELEMETRY,
  doNotTrack: process.env.DO_NOT_TRACK,
  adapterOnly: process.env.MUHA_ADAPTER_ONLY ?? null,
  mcpPayloadOnly: process.env.MUHA_MCP_PAYLOAD_ONLY ?? null,
})}\n`);
