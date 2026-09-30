import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { controlledPi, nativePi } from "../../packages/pi-adapter/test/support/controlled-pi.mjs";

export async function piConformance(t, { rich = false, sessionsFile } = {}) {
  const fixture = await controlledPi(t, rich ? (_request, response, number) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const emit = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({
      id: `answer-${number}`, object: "chat.completion.chunk", created: number, model: "controlled",
      choices: [{ index: 0, delta, finish_reason }],
    })}\n\n`);
    emit({ role: "assistant", reasoning_content: "Check the Workspace.", content: "Checking." });
    if (number === 1) {
      emit({ tool_calls: [{ index: 0, id: "write-1", type: "function",
        function: { name: "write", arguments: JSON.stringify({ path: "conformance.txt", content: "Pi native tool" }) } }] }, "tool_calls");
    } else emit({ content: "Done." }, "stop");
    response.end("data: [DONE]\n\n");
  } : undefined);
  await writeFile(join(fixture.agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "controlled", defaultModel: "controlled", defaultThinkingLevel: "medium", compaction: { enabled: false },
  }));
  if (sessionsFile) {
    const rows = JSON.parse(await readFile(sessionsFile, "utf8"));
    await nativePi(fixture, `
      const NativeDate = Date;
      globalThis.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : [1700000000000])); } };
      for (const row of JSON.parse(process.argv[2])) {
        const manager = sdk.SessionManager.create(row.workspacePath, undefined, { id: row.id });
        manager.appendModelChange("controlled", "controlled");
        manager.appendMessage({ role: "user", content: [{ type: "text", text: "External history" }], timestamp: 1700000000000 });
        manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "External answer" }], timestamp: row.updatedAt,
          api: "openai-completions", provider: "controlled", model: "controlled", stopReason: "stop",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
        if (row.title) manager.appendSessionInfo(row.title);
      }
      console.log("null");
    `, [JSON.stringify(rows)]);
  }
  return fixture;
}
