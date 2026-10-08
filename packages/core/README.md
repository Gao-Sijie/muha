# @muha-sdk/core

Core Runtime, Workspace, Agent Session, Turn, event, error, and diagnostic-storage contracts for [Muha SDK](https://github.com/Gao-Sijie/muha).

Install this package together with only the official Adapter packages you use.
V0.1.13 supports Node.js `>=22.20.0` on Linux x64 glibc and WSL2. Consumers
must independently install and authenticate the Codex, OpenCode, Kimi and AGY native
commands and make them available on `PATH`; Muha never installs, upgrades, downloads,
authenticates, or repairs those native commands. The Pi Adapter is a
scoped exception: its package declares a fixed official Pi SDK dependency and needs no Pi
CLI; callers still supply native authentication and model configuration.

```ts
import { createMuhaRuntime } from "@muha-sdk/core";
import { codexAdapter } from "@muha-sdk/codex-adapter";

const runtime = await createMuhaRuntime({ harnesses: [codexAdapter()] });
try {
  await runtime.configureWorkspace({
    workspacePath: "/absolute/project",
    skills: [{ source: "./skills" }],
    mcpServers: [{ name: "local", transport: "stdio", command: "local-mcp" }],
  });
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

## Session References

Retain `session.reference` (or a native listing's `reference`) to resume a
conversation. The only supported shape is
`{ harness, sessionId, workspacePath, route }`: all four fields are required,
and `route` is Muha's integration identity, not a caller-selected protocol.
`parseSessionReference()` validates external JSON; `serializeSessionReference()`
validates before serialization. Runtime resumption uses the same interpreter.

Old three-field references, any `formatVersion` field, and unknown or malformed
fields fail with `INVALID_SESSION_REFERENCE` before native operations. There is
no automatic migration or route inference. This does not delete native Sessions
or historical Muha data; a valid current reference still resumes the native
conversation in its canonical Workspace, subject to native availability.

## Process cleanup boundary

Under ADR-0138, shared ACP routes use a dedicated Muha cleanup helper, distinct
from any third-party ACP bridge. While it is alive, normal closure and Harness failure
retain the complete owned-process reclamation contract, including resistant
and detached descendants, without touching unrelated processes.

If that helper itself dies, Muha reports the loss and irreversibly closes the
whole Runtime (or rolls back initialization), but cannot guarantee that all
descendants stop. Tools may continue running after the Runtime closes. Failed
cleanup is exposed through `runtime.termination.closeError` and a rejecting
`runtime.close()`; initialization failures retain rollback failures. Muha does
not silently restart or replay work. This exception does not excuse cleanup
failures while the helper is alive, and adds no systemd, namespace or privileged
setup requirement. AGY has its separately documented supervisor-loss boundary;
other native routes do not inherit this shared-ACP exception.

## Harness Capabilities

Every enabled official Harness has one static `HarnessCapabilities` Profile.
Discovery is optional: established calls continue to work unchanged, and Core
enforces the declaration even when a consumer never reads it.

```ts
const capabilities = runtime.getHarnessCapabilities("codex");
if (capabilities.imageInput) {
  // Image parts are accepted by this Harness.
}
```

`getHarnessCapabilities()` is synchronous and performs no native command,
filesystem, network, model, or version probe. It returns the same deeply frozen,
JSON-safe snapshot throughout the Runtime lifetime and remains available after
`runtime.close()`. A valid Harness that was not enabled returns
`HARNESS_NOT_ENABLED`; an invalid Harness value returns `INVALID_INPUT`.

The Profile describes these independently enforceable contracts:

- `sessionListing` and `imageInput` cover the existing listing and image-part
  APIs.
- `approvalPolicies` is the exact non-empty set accepted by Session create and
  resume. Omission still selects `interactive`. `harnessManaged` delegates all
  decisions to native Harness configuration, emits no Muha Approval events, and
  performs no automatic allow or deny.
- `turnQuestions`, `assistantMessageStreaming`,
  `assistantReasoningStreaming`, `toolEvents`, and `turnUsage` govern complete
  public event contracts. The final Assistant Message remains mandatory Kernel
  behavior even when message streaming is false; Core does not synthesize
  streaming fragments or telemetry.
- `workspaceSkills` and `workspaceMcp` apply independently to every
  Harness/input pair in the existing best-effort Workspace matrix.
- `model.selectionAt` and `effort.selectionAt` list the supported
  `createSession`, `resumeSession`, and `idleSession` operation points.
  `observation: "selectedOnly"` reports only caller/native selected state;
  `"effective"` promises the effective value. `effort.requiresKnownModel`
  states whether effort validation requires a resolved current model.

Codex, OpenCode, and Kimi Code currently declare listing, image input, all
three existing Approval Policies, Questions, Skills, MCP, all three model and
effort selection points, both Assistant streams, Tool Events, and Turn Usage.
Codex declares effective model observation, selected-only effort observation,
and no known-model requirement for effort. OpenCode and Kimi Code declare
selected-only model/effort observation and require a known model for effort.
The Pi Profile additionally supports `autoApprove` and
`harnessManaged`, but not `interactive`, `autoDeny`, Questions or Workspace MCP.
It supports listing, ordered images, Skills, both streams, tools and usage, and
effective model/effort selection at all three points with a known model required
for effort. Native Pi extensions, including MCP extensions, remain unmanaged;
their availability does not change this static Profile. Pi callers must supply
a supported policy explicitly because the common default is still `interactive`.

The AGY Profile supports text, known-reference resume, Skills,
message streaming, tools and current-Turn usage. It supports `harnessManaged`
and `autoApprove`, and selected-only model/effort at create/resume. Listing,
images, idle selection, structured approvals/questions, reasoning streaming
and managed Workspace MCP are unsupported. Select a supported policy explicitly.
AGY `autoApprove` uses native `--dangerously-skip-permissions`. The Adapter
warns about its native ten-minute Turn limit; detected partial timeout output
is a failure. See the [AGY package](../agy-adapter/README.md) for its process
supervisor, native metadata and qualification boundaries.

### V0.1.12 autoApprove migration

`autoApprove` selects the Adapter's native autonomous execution mode and
automatically answers any remaining native Approval Request with `allowOnce`.
Codex uses approval and sandbox bypass; Kimi uses `auto`; OpenCode preserves
native permission rules and replies `once` to requests in the active Session
tree. These modes do not promise equivalent permissions or successful tools.
No request means no Approval events. Actual requests retain their paired
resolution with `source: "policy"` only after a successful reply.

`interactive` still surfaces native requests; `autoDeny` denies requests and
does not prohibit tools that the Harness runs without asking. Questions remain
independent and have no implicit timeout. `turnQuestions` describes the
Harness's Question lifecycle, not whether every policy produces Questions.

Each Muha create/resume must establish its selected policy or fail. Native
Session modes can survive normal close or abnormal exit; close does not roll
them back, and native CLI resume may inherit them. User and Workspace permission
configuration is not used to implement Session policies. Existing call shapes
and the Capability Profile shape remain valid, but permissions, Questions and
Approval event frequency can change. Use explicit supported policies for AGY/Pi
because Core's default is `interactive`. See the
[qualification and limitations](https://github.com/Gao-Sijie/muha/blob/main/QUALIFICATION.md). Historical local
release formats are not the independent SDK's distribution gate.

An unsupported direct operation rejects before its native action with
`MuhaError.data.code === "UNSUPPORTED_CAPABILITY"` plus exact `harness`,
`capability`, and `operation` fields. Unsupported Workspace pairs instead
return one direct failed attempt and do not invoke a planner or worker. Once a
Turn is accepted, an Adapter event forbidden by its Profile is a declaration
violation and ends that Turn with `ADAPTER_PROTOCOL_ERROR`; it is never silently
dropped or relabeled as an unsupported command.

`ApprovalPolicy`, `MuhaErrorData`, and the failed-attempt `error` member of
`WorkspaceConfigurationAttempt` have new union members in V0.1.11. Consumers
with exhaustive TypeScript switches must add `harnessManaged`,
`UNSUPPORTED_CAPABILITY`, and the unsupported Workspace-attempt case.

`OfficialAdapterOptions.env` changes only the native Harness process. Workspace workers
inherit the consumer process environment with telemetry disabled. A
stdio MCP server's `env` is configuration payload written to native project
files; it is not applied to the Workspace worker.

Diagnostic records contain complete, unredacted native data. V0.1 provides no encryption, retention, pruning, rotation, delete, query, replay, or export API,
so storage can grow without bound. Different Harnesses are not semantically
equivalent and Muha does not promise identical output. V0.1 explicitly does not support
third-party Harness registration. V0.1.13 supports the five-official-Harness
set, including Pi and AGY; the [current qualification](https://github.com/Gao-Sijie/muha/blob/main/QUALIFICATION.md)
records source and exceptions; the [AGY qualification](https://github.com/Gao-Sijie/muha/blob/main/QUALIFICATION.md)
retains AGY's model-level effort N/A. Qualification evidence and publication acceptance are recorded separately.
