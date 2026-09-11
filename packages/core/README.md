# @muha-sdk/core

Core Runtime, Workspace, Agent Session, Turn, event, capability, error, and diagnostic-storage contracts for Muha.

Install Core together with only the official adapter packages your application uses.

```bash
npm install @muha-sdk/core @muha-sdk/codex-adapter
```

```ts
import { createMuhaRuntime } from "@muha-sdk/core";
import { codexAdapter } from "@muha-sdk/codex-adapter";

const runtime = await createMuhaRuntime({ harnesses: [codexAdapter()] });
try {
  const session = await runtime.createSession({
    harness: "codex",
    workspacePath: "/absolute/project",
  });
  const turn = await session.startTurn([{ type: "text", text: "Review this project." }]);
  for await (const event of turn) {
    if (event.type === "assistant.message.delta") process.stdout.write(event.delta);
  }
} finally {
  await runtime.close();
}
```

## Capabilities

Every enabled Harness exposes one static, immutable `HarnessCapabilities` profile through `runtime.getHarnessCapabilities(harness)`. Core enforces capability declarations even if callers never inspect them. Unsupported operations reject with structured `UNSUPPORTED_CAPABILITY` errors instead of falling back lossily.

## Errors

Public command failures use `MuhaError` with structured `data.code`. Native Harness failures are represented by `HARNESS_ERROR` with `harness`, `operation`, optional `nativeCode`, and optional `retryable`. `nativeCode` is Harness-native and must not be treated as a cross-Harness taxonomy.

## Diagnostic Event Store

Each Runtime owns a private SQLite Diagnostic Event Store under its `dataDir`. It can contain complete, unredacted native payloads including prompts, model output, tool input/output, file content, and provider metadata. The current SDK does not provide encryption, retention, pruning, rotation, query, replay, export, or delete APIs, so callers must protect and capacity-manage this directory themselves.

## Internal subpath

`@muha-sdk/core/internal` exists for Muha's official first-party adapters. It is not a supported third-party adapter SPI and may change between pre-1.0 releases.

Muha currently targets Node.js `>=22.20.0` on Linux x64 glibc, including WSL2.
