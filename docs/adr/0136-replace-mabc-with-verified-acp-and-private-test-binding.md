# Replace MABC with verified ACP and private test binding

Status: accepted through the user-approved [remediation design (historical private reference)](../testing/private-history.md) on 2026-09-17; supersedes ADR-0134. Real route qualification remains outstanding.

The rejected candidate's invented MABC messages and publicly typed `acp` option do not satisfy ACP-first: real OpenCode initialization accepts ACP v1 and rejects that wire format. Replace the shared stack in place using verified upstream schemas and per-Harness operation evidence, preserving complete Profiles and native Session authority; keep controlled endpoint injection exclusively in repository-internal tests, with official options limited to `env`, `startupTimeoutMs`, and `shutdownTimeoutMs`.

## Consequences

- Do not retain MABC as a compatibility layer or use a synthetic endpoint as proof of real ACP admission. Existing artifacts and historical failure records remain intact.
- This decision does not switch a default or declare a Harness qualified. Native composition needs evidence of identical native identity, configuration, current permission policy, and sole execution ownership before selection.
- Reference interpretation follows ADR-0135. Tests reuse private construction seams without adding package exports, public protocol selectors, or environment selectors.
- If verified upstream behavior cannot preserve a full Profile or the required second real shared integration, report the unresolved admission requirement instead of weakening it.
