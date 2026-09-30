# Session Reference format v2 (route identity) and legacy interpretation

Status: superseded on 2026-09-17 by [ADR-0135](0135-reset-muha-artifacts-to-one-session-reference-format.md). The text below records the historical decision, not the current implementation or acceptance target.

Historical status: accepted for the ACP-first internal candidate; implements REQ-04/06/08 and the
frozen contract in `docs/proposal/2026-09-16-acp-first-spec.md` (design task T10).
Supersedes the implicit three-field V0.1 reference encoding; ADR-0005 (native Session
authority) and ADR-0118 (static capability declarations) remain in force.

## Problem

V0.1 Session References are the JSON-safe triple `{harness, sessionId, workspacePath}`.
Once a Harness Adapter may fulfill its behavior through ACP, native, or a verified
combination, a reference must unambiguously identify the Harness Integration Route
needed for resumption, without exposing a public protocol selector to callers and
without breaking existing persisted references.

## Decision

### Shape

References keep their JSON-safe object form and gain a `route` identity plus an
explicit format version:

- v1 (legacy): `{ harness, sessionId, workspacePath }` — written without
  `formatVersion`/`route`; its route is the **implicit native** interpretation.
- v2 (new): `{ formatVersion: 2, harness, sessionId, workspacePath, route }` where
  `route` is one of `"native" | "acp" | "combined"`.

`Harness Integration Route` is a Muha-selected fulfillment identity for one Harness;
it is distinct from Harness Kind, from the native Session ID, and from any transport.
Callers still select only a Harness; Core and the Adapter own the route.

### Interpretation rules (deterministic, no guessing)

| Input | Interpretation |
| --- | --- |
| `{harness,sessionId,workspacePath}` (v1) | route = `native`, formatVersion 1 |
| `{formatVersion:2, harness, sessionId, workspacePath, route}` | route as written |
| `formatVersion` other than missing/2 | error `INVALID_SESSION_REFERENCE` (unsupported version) |
| missing/`""`/null fields (`harness`,`sessionId`,`workspacePath`,`route`) | error `INVALID_SESSION_REFERENCE` |
| unknown `route` | error `INVALID_SESSION_REFERENCE` |
| unknown Harness Kind | error `UNKNOWN_HARNESS` (existing classification) |
| `workspacePath` not absolute or not existing canonical path | `INVALID_SESSION_REFERENCE` / `WORKSPACE_NOT_FOUND` respectively |
| session cannot be restored by the referenced Harness/route | `SESSION_NOT_FOUND`, never create a replacement Session |

### Creation

Core builds v2 references at Session creation/resume with the Adapter's declared
route (`LiveHarnessAdapter.route`, default `"native"`) — no caller-supplied route.

### Serialization

`serializeSessionReference` (JSON round-trip safe) and `parseSessionReference`
(enforcing the table above) are exported; references remain deep-frozen objects.

### Diagnostics

Native Event Records and Core Event Records carry `route` attribution for
interpretable diagnosis; diagnostic data never becomes a public raw event API.

## Compatibility

- Old persisted references (v1) parse deterministically to `native`; no migration
  of native Session data is performed.
- All current five Adapters declare `native` by default, so current behavior is
  unchanged until a Driver ships with an ACP/combined route and passes admission.
- The default route of every existing Adapter is unchanged by this ADR.

## Cross-cutting

- No new public ACP/native selector; no public dynamic capability API.
- Unknown identities fail explicitly; no silent Session replacement, no cross-route
  retry (ADR-0130).
- T31 (Orchestrator) must pass v1 and v2 references through unchanged.
