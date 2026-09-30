# Shared ACP bridge layer with internal test binding (Muha ACP Bridge Contract)

Status: superseded by [ADR-0136](0136-replace-mabc-with-verified-acp-and-private-test-binding.md) on 2026-09-17. The original decision below is retained as historical context, not the current implementation contract.

Historical status: accepted for the ACP-first internal candidate; freezes the shared connection
and translation layer design (T10). The public Core Kernel, complete static Capability
Profiles, and native Session authority are unchanged; Pi retains its recorded SDK
exception (ADR-0120..0123). Real served ACP endpoints were not available at the
spiked versions (T05/T06 handoffs record `opencode acp` exiting on start and no
resolvable `codex-acp` bridge), so the protocol surface below is frozen as a
controlled contract modeled on ACP 2025-03-26 method names and executed against
test-controlled endpoints; real admission remains the T19/T24 gate and may revise
this contract through the design-update process before any default switch.

## Scope

A shared, Harness-neutral implementation owned by Core, consumed by the OpenCode and
Codex Drivers (and available to Kimi/AGY later only through their own admission),
implementing:

- connection lifecycle and ownership (spawn/attach, initialize handshake, close,
  duplicate-close, process exit),
- JSON-RPC request/notification correlation,
- Session create/resume/list, Turn prompt/cancel, Approval and Question responses,
- translation of agent events to `AdapterTurnEvent` (existing Core contracts),
- failure classification and pending-interaction invalidation.

## Muha ACP Bridge Contract (MABC v0.1) — frozen message surface

Framing: newline-delimited JSON-RPC 2.0 over the adapter-owned duplex (stdio child
process in the internal binding; the same client drives any ACP agent service that
speaks this contract).

Host→Agent requests: `initialize`, `session/new` `{cwd}`, `session/load` `{sessionId}`,
`session/list` `{cwd}`, `session/prompt` `{sessionId, prompt:{parts:[...]},
modelPreferences, permissionMode}`, `session/cancel` `{sessionId, promptRequestId}`,
`session/close` `{sessionId}`, `session/set_model`, `session/set_effort` (extension,
see below).

Agent→Host notifications: `session/update` `{sessionId, promptRequestId, status:
{type:"started"|"completed"|"error"|"cancelled"}, messages:[message parts]}`,
`session/request_permission` `{sessionId, promptRequestId, permissionId, title,
explanation?, toolCall?}`, `elicitation/create` `{sessionId, promptRequestId,
elicitationId, questions:[...]}` (Question support), `fs/read_text_file`,
`fs/write_text_file` (required Host file methods), `terminal/create|output|wait_for_exit`
(not supported: deterministic rejection).

Message parts in `session/update`: `text` (with `delta`/`final`), `reasoning` (with
delta), `tool_call` (`{callId,name,input}`), `tool_call_update`, `tool_result`
(`{callId,output,isError}`), `usage` `{inputTokens,outputTokens,cachedInputTokens,
reasoningTokens}` (Muha extension; native-absent must not fabricate **zero**).

Permission reply: the host answers the `session/request_permission` notification with
a response whose `result` is `{action:"accept"|"decline"}` or an `error`; one-shot.
Elicitation reply: `elicitation/complete` with answers or an explicit decline.

## Ownership and failure

| Resource | Owner | Failure impact |
| --- | --- | --- |
| ACP connection/process | Adapter Driver (created at initialize, closed at close) | driver-level fatal → all its Sessions fail per existing contract; never touches unrelated processes |
| Session | native Harness (ADR-0005) | connection loss → explicit restore or `SESSION_NOT_FOUND` |
| Turn waiters | Driver turn state | cancel/close/failure settle every waiter; late callbacks must not act |
| Pending Approval/Question | Driver per Session, invalidated on turn end | idempotent rejection of late replies |

No automatic cross-route retry; Core Turn Retry Policy stays the only retry, applied
to retryable Harness failures, never by switching route.

## Internal test binding

- The ACP route option on an Adapter is **internal-test-only**: it is not a public
  protocol selector, is not advertised in docs as supported, and production default
  remains the existing native route for every Harness.
- Tests bind to a controlled endpoint fixture implementing MABC v0.1, including
  failure injection (malformed frames, unexpected exit, unknown requests, delayed
  responses, permission/question races).
- ACP negotiation is a compatibility check against the frozen contract; gaps fail
  deterministically per the error contract instead of shrinking the public Profile.

## Error contract (new/used codes)

- `ADAPTER_PROTOCOL_ERROR` — malformed/misordered MABC frames, unknown request,
  negotiation gap.
- `INVALID_SESSION_REFERENCE` — reference shape/version/route violations (ADR-0133).
- Existing `HARNESS_ERROR`, `SESSION_NOT_FOUND`, `SESSION_BUSY`, `UNSUPPORTED_CAPABILITY`,
  `TURN_INTERACTION_*` keep their semantics.

## Cross-cutting

- No new runtime dependencies (stdio JSON-RPC implemented on Node built-ins); new
  dependency audits must re-run `npm run audit:delivery`.
- No Host methods beyond fs read/write are claimed; terminal is deterministically
  rejected. Workspace Skills/MCP configuration stays with the existing
  workspace-configurator (affirmed by ADR-0023/0004).
- Résumé direction claims only proven directions (T05/T06 evidence).
