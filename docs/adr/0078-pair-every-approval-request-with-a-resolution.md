# Pair Every Approval Request with a Resolution

[ADR-0119](0119-select-native-autonomous-execution-through-auto-approve.md)
changes how often native Approval Requests occur under `autoApprove`, not this
pairing invariant. Resolution as approved requires a successful native reply;
direct native execution or refusal generates no synthetic pair.

`approval.requested` carries `{ requestId, title, description?, toolCallId?, details? }`, where the Core ID is per-Turn unique, title is non-empty, optional details are normalized `JsonValue`, and a tool ID is present only for an already-started related call. `approval.resolved` carries the request ID and either `{ outcome: "allowOnce" | "deny"; source: "caller" | "policy" }` or `{ outcome: "invalidated"; source: "harness" | "turn" }`. Interactive responses identify the caller, automatic Approval Policy emits requested then immediately resolved without waiting and identifies policy, native withdrawal identifies Harness, and every still-pending request is invalidated by Turn before its terminal event. Every request receives exactly one resolution. Muha V0.1 exposes no allow-always, Session authorization, request mutation, or native decision; subsequent commands receive the existing resolved or invalidated rejection.
