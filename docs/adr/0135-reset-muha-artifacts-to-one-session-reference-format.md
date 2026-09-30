# Reset Muha artifacts to one Session Reference format

Status: accepted by the user on 2026-09-17; supersedes ADR-0133 and the legacy Muha-format compatibility obligations in ADR-0130 and the original ACP-first plan/spec. Implementation and candidate acceptance remain outstanding.

Before the first open-source delivery, Muha adopts one closed, JSON-safe Session Reference shape, `{ harness, sessionId, workspacePath, route }`, with all four fields required and no `formatVersion`, so callers do not inherit internal format generations. Old Muha-produced formats are outside the compatibility and migration contract: old three-field references, references containing any `formatVersion`, and other malformed shapes are rejected with `INVALID_SESSION_REFERENCE`, rather than upgraded, guessed, or silently stripped. Native Harness Session authority, verified native-session restoration, complete Capability Profiles, and Muha-owned route selection remain unchanged.

## Consequences

- `route` remains a Muha-produced identity (`native`, `acp`, or `combined`), not a caller-selected protocol; parsing, Runtime input, serialization, listing, and Orchestrator use the same contract.
- Rejecting old Muha serialization does not delete native sessions or waive restoration through the new valid reference format; native/ACP composition still needs its original proof of identity and sole execution ownership.
- Other old Muha-produced data formats carry no compatibility/migration promise, but their retirement does not authorize deleting or overwriting user data. Unsupported stored data is rejected non-destructively; current-format diagnostic integrity remains mandatory.
- Preserve historical artifacts, checksums, and acceptance evidence. Package SemVer, upstream protocol versions, private storage metadata, and planning-file schema identifiers are separate from the public Session Reference and are not removed or renumbered by this decision.
- Retaining `formatVersion:1` was considered and rejected in favor of a single unversioned public reference. Any future format evolution requires a separate decision; this does not pre-authorize future compatibility breaks.
- This prepares the API for a future open-source release but does not expand the current internal-only repository, project acceptance, or no-publication scope.
