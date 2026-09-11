# Muha

**An embeddable TypeScript SDK for controlling multiple native coding harnesses through one typed runtime.**

Muha gives Node.js applications a common `Runtime → AgentSession → TurnHandle` control model for native coding harnesses without adding a daemon, Docker service, hosted control plane, or its own agent loop.

Muha is intentionally **native-first**: each harness remains authoritative for its own sessions, models, authentication, tools, and behavior. Muha normalizes the control surface where portability is useful and keeps harness-specific differences explicit through capability profiles and native identifiers.

## Why Muha

- **Embedded, not hosted** — use Muha directly inside a Node.js / TypeScript process.
- **No harness installation layer** — Muha uses the native harnesses you already install and authenticate.
- **Install only what you need** — pair `@muha-sdk/core` with the adapter packages your application uses.
- **Typed control portability** — common runtime, session, turn, event, approval, question, model, effort, and workspace contracts.
- **Capability-aware** — harness differences are declared and enforced instead of being hidden behind lossy emulation.
- **Native sessions stay native** — Muha does not create a replacement transcript or session database.

## Supported adapters

The first public release targets:

- `@muha-sdk/codex-adapter`
- `@muha-sdk/opencode-adapter`
- `@muha-sdk/kimi-adapter`

Muha currently targets Node.js `>=22.20.0` on Linux x64 glibc, including WSL2. Each native harness must be installed, authenticated, and available on `PATH` independently.

## Quick start

```bash
npm install @muha-sdk/core @muha-sdk/codex-adapter
```

```ts
import { createMuhaRuntime } from "@muha-sdk/core";
import { codexAdapter } from "@muha-sdk/codex-adapter";

const runtime = await createMuhaRuntime({
  harnesses: [codexAdapter()],
});

try {
  const session = await runtime.createSession({
    harness: "codex",
    workspacePath: "/absolute/project/path",
  });

  const turn = await session.startTurn([
    { type: "text", text: "Review this repository." },
  ]);

  for await (const event of turn) {
    if (event.type === "assistant.message.delta") {
      process.stdout.write(event.delta);
    }
  }

  const result = await turn.result;
  console.log(result.status);
} finally {
  await runtime.close();
}
```

## What Muha is not

Muha is not a multi-agent framework, router, remote execution service, sandbox, UI, or hosted backend. It does not install or authenticate native harnesses and does not promise that different harnesses produce equivalent behavior.

Those boundaries are deliberate: Muha is the small control layer you can embed underneath your own application or orchestration system.

## Packages

| Package | Purpose |
| --- | --- |
| `@muha-sdk/core` | Runtime, sessions, turns, events, capabilities, workspace configuration, and structured errors |
| `@muha-sdk/codex-adapter` | Official Codex integration |
| `@muha-sdk/opencode-adapter` | Official OpenCode integration |
| `@muha-sdk/kimi-adapter` | Official Kimi Code integration |

See each package README for adapter-specific behavior and support boundaries.

## Status

Muha is pre-1.0 software. Public APIs are typed and contract-tested, but the project may still make deliberate breaking changes between minor releases while the SDK boundary stabilizes.

## License

MIT
