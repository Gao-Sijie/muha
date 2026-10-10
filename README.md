# Muha

[English](README.md) | [简体中文](README.zh-CN.md)

One TypeScript API for Codex, OpenCode, Kimi Code, Pi, and AGY.

Use your coding agents from scripts and applications: create sessions, stream
responses and tool activity, interrupt work, and resume native conversations.
Each agent keeps its own models, tools, permissions, and conversation history.

## Install

> Version 0.1.15 is being prepared for npm publication. Until `@muha-sdk/muha` is published,
> use the existing [individual packages](#install-only-what-you-need).

```sh
npm install @muha-sdk/muha
```

Requires Node.js **22.20.0 or newer** on **Linux x64 with glibc 2.28 or newer**,
including WSL2 environments that meet these requirements. Muha ships its own
native helpers prebuilt; you do not need to clone or build this repository.

This installs Core and all five adapters. Enable only the agents you use.
Codex, OpenCode, Kimi Code, and AGY need their native tools installed and
authenticated on `PATH`. Pi's SDK is included as an npm dependency; configure
its native authentication and model before using it.

## Quick start

With Codex installed and signed in, save this as `example.mjs`:

```js
import { createMuhaRuntime, codexAdapter } from "@muha-sdk/muha";

const runtime = await createMuhaRuntime({ harnesses: [codexAdapter()] });
try {
  const session = await runtime.createSession({
    harness: "codex",
    workspacePath: process.cwd(),
    approvalPolicy: "autoDeny",
  });
  const turn = await session.startTurn([
    { type: "text", text: "Explain the structure of this project." },
  ]);
  for await (const event of turn) {
    if (event.type === "assistant.message.delta") process.stdout.write(event.delta);
    if (event.type === "question.requested") {
      await turn.respondToQuestion(event.requestId, { action: "dismiss" });
    }
  }
  const result = await turn.result;
  if (result.status !== "completed") {
    console.error(result);
    process.exitCode = 1;
  }
} finally {
  await runtime.close();
}
```

```sh
node example.mjs
```

The example denies tool actions that request approval and dismisses follow-up
questions. Choose a supported approval policy and handle questions for your
workflow; policy details differ between agents.

## Choose an agent

| Agent | Adapter | Setup |
| --- | --- | --- |
| [Codex](packages/codex-adapter/README.md) | `codexAdapter()` | Install and authenticate `codex` |
| [OpenCode](packages/opencode-adapter/README.md) | `openCodeAdapter()` | Install and authenticate `opencode` v2 |
| [Kimi Code](packages/kimi-adapter/README.md) | `kimiAdapter()` | Install and authenticate `kimi` |
| [Pi](packages/pi-adapter/README.md) | `piAdapter()` | SDK installed with Muha; configure native auth/model |
| [AGY](packages/agy-adapter/README.md) | `agyAdapter()` | Install and authenticate `agy` |

Pass your chosen adapters to `createMuhaRuntime({ harnesses: [...] })`.
Only configured agents start. Pi and AGY require an explicit supported policy,
such as `harnessManaged`; they do not support the default `interactive` policy.

## More ways to use Muha

- Keep `session.reference` to resume the same native conversation.
- Read `runtime.getHarnessCapabilities(...)` before using optional features.
- Use `turn.interrupt()` to stop a running turn.
- Configure workspace Skills and MCP where supported by your chosen agent.

See the [API guide](packages/core/README.md) and [verified versions and
limitations](QUALIFICATION.md). A common API preserves agent-specific behavior;
it does not promise identical answers or a shared model catalog.

## Install only what you need

If you prefer a smaller dependency set:

```sh
npm install @muha-sdk/core @muha-sdk/pi-adapter
```

Import directly from those packages and keep them on the same Muha release.

## Troubleshooting

If an enabled agent cannot start, check its native tool is on `PATH` and its
authentication is configured. The adapter guides above list setup requirements.
If your package manager blocks dependency install scripts, review its reported
dependencies and script policy. Keep normal install behavior for dependencies;
compiling Muha from source is not a required setup step.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and tests.
Report problems in [GitHub Issues](https://github.com/Gao-Sijie/muha/issues).
Security reports: [SECURITY.md](SECURITY.md). Licensed under [MIT](LICENSE).
