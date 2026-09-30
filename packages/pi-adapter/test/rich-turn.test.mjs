import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { controlledPi, completedTurn } from "./support/controlled-pi.mjs";

test("Pi streams reasoning, executes a real tool and reports cumulative usage before its sole terminal", async t => {
  const fixture = await controlledPi(t, (_request, response, number) => {
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const emit = (delta, finish_reason = null, usage) => response.write(`data: ${JSON.stringify({
      id: `answer-${number}`, object: "chat.completion.chunk", created: number, model: "controlled",
      choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}),
    })}\n\n`);
    emit({ role: "assistant" });
    if (number === 1) {
      emit({ reasoning_content: "I should write the requested file." });
      emit({ content: "Writing it now." });
      emit({ tool_calls: [{ index: 0, id: "write-1", type: "function",
        function: { name: "write", arguments: JSON.stringify({ path: "proof.txt", content: "native Pi write" }) } }] });
      emit({}, "tool_calls", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    } else {
      emit({ content: "The file is ready." });
      emit({}, "stop", { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 });
    }
    response.end("data: [DONE]\n\n");
  });
  const runtime = await fixture.runtime();
  const session = await runtime.createSession({ harness: "pi", workspacePath: fixture.workspace,
    model: "controlled/controlled", approvalPolicy: "autoApprove" });
  const { result, events } = await completedTurn(session, "Write proof.txt");
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(result.message.text, "The file is ready.");
  assert.equal(await readFile(join(fixture.workspace, "proof.txt"), "utf8"), "native Pi write");
  assert.equal(events.filter(e => e.type === "assistant.reasoning.delta").map(e => e.delta).join(""), "I should write the requested file.");
  assert.equal(events.filter(e => e.type === "assistant.message.delta").map(e => e.delta).join(""), "Writing it now.The file is ready.");
  assert.deepEqual(events.filter(e => e.type.startsWith("tool.")).map(e => e.type), ["tool.started", "tool.completed"]);
  assert.equal(events.find(e => e.type === "tool.completed").isError, false);
  assert.deepEqual(events.filter(e => e.type === "usage.updated").at(-1).usage, { inputTokens: 30, outputTokens: 11, cachedInputTokens: 0 });
  assert.deepEqual(events.filter(e => ["turn.completed", "turn.failed", "turn.interrupted"].includes(e.type)).map(e => e.type), ["turn.completed"]);
  assert.equal(events.some(e => e.type.startsWith("approval.")), false);
});
