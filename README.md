# Muha

[English](README.md) | [简体中文](README.zh-CN.md)

One TypeScript API for Codex, OpenCode, Kimi Code, Pi, and AGY.

Muha is a lightweight TypeScript SDK for using coding agents in scripts and apps.
Choose harnesses and models, connect tasks in code, and keep their native capabilities.
A harness is a full agent runtime with models, tools, permissions, and history,
not just a model API.

## Why Muha

- **Task-aware spending** Use cost-effective models for routine work and stronger
  setups for difficult steps, combining existing subscriptions and providers.
- **Automated handoffs** Connect research, writing, and review in code, passing
  material and handling results without repeated terminal operations.
- **Less integration glue** Manage startup, sessions, events, and interactions
  across harnesses through one API instead of rebuilding each integration.

## How it works

- **Lightweight TypeScript API** Manage Sessions, Turns, streams, interactions,
  interruption, and opt-in retries in ordinary Node.js code, without a workflow DSL.
- **Native capabilities** Reuse each harness's models, tools, auth, permissions,
  history, and supported Skills/MCP. Native billing still applies;
  Muha does not automatically select the cheapest model.
- **No extra deployment** No separate Muha server, container platform, or
  additional sandbox layer is required. Adapters may manage local helpers or native
  services; Muha is not a security isolation boundary.

## What you can build

- **Flexible workflows** Reuse Sessions for ongoing context or create a fresh
  Session per independent task. A Session permits one active Turn at a time;
  parallel tasks use separate Sessions.
- **Harness and model comparisons** Run the same task in separate Sessions for
  evaluations, prompt experiments, or cross-checks. Your application supplies
  scoring and cost estimates; Muha supplies a common execution API.
- **Agent-led orchestration** Expose Muha as tools or scripts so an orchestrator
  harness can delegate to others and collect results. Your code owns routing,
  planning, and scheduling.
- **Applications and scripts** Build chat, research-to-draft pipelines,
  code-review tools, or batch file processing with the same execution controls.

**Boundaries** Muha is not a built-in workflow scheduler or orchestrator.
A Session stays bound to its harness and workspace; switching harnesses requires
a new Session, without automatic conversation-history migration. Query optional
capabilities: a common API does not promise identical capabilities or outputs.

## Install

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

## Examples

Browse the [examples catalog](examples/README.md) for runnable scenarios, each
with its own source and setup guide.

Both examples require the complete `@muha-sdk/muha` installation and offer only
locally installed harnesses; installing all native CLIs is unnecessary. Pi's SDK
comes with Muha, while other harnesses need their native CLI on `PATH`.

| Project | Overview | Location |
| --- | --- | --- |
| [Multi-Harness Chat](examples/local-chat/README.md) | Single-file server and chat UI: five adapters, native model/effort, inline Turn events, approvals, Questions and interruption. Settings apply to new conversations only. | [examples/local-chat/](examples/local-chat/) |
| [AI Topic & Writing](examples/auto-social-media/README.md) | Interactive command-line research-to-draft workflow using `content-strategy` and `khazix-writer`. Independently choose each agent's harness/model/effort, stream model replies in the terminal and inspect the retained workspace. Real models require explicit consent. | [examples/auto-social-media/](examples/auto-social-media/) |

Examples live in this GitHub repository, not the npm package. Adding examples
does not require a new SDK release. See [example contribution guidance](CONTRIBUTING.md#examples).

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

## Working with the API

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

## Available models

```js
const models = await runtime.listModels({ harness: "codex", workspacePath: process.cwd() });
// Use the same call with opencode, kimi, pi, or agy when enabled.
console.log(models.map(model => ({ id: model.id, name: model.name })));
```

`listModels` reads the enabled Harness's native selectable chat-model catalog.
It requires an existing Workspace and does not create a Session, run inference,
or change model defaults. The result is a deeply frozen, JSON-safe array; each
native `id` can be passed unchanged to that Harness's model selection APIs.
Optional `name`, `description`, `supportedEfforts`, and `defaultEffort` appear only
when reported natively. Effort values retain their Harness-specific meaning.
A successful empty catalog returns `[]`; query and format failures reject.
Catalogs reflect native configuration/authentication and native caching, and do
not guarantee credentials, quota, or the success of a later model request.
The static declaration is `runtime.getHarnessCapabilities(harness).model.listing`.

For Codex, OpenCode, Kimi, and Pi, use `await session.setModel(id)` between Turns
to retain the same conversation with a different model. This clears the previous
explicit effort selection; the Harness may apply its native default. AGY model
selection remains limited to create/resume; its idle setter is unsupported.
