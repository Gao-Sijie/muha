---
status: superseded by ADR-0042
---

# Keep Harness Adapters private

Muha's public lifecycle is `Muha Runtime → Agent Session → Turn`, with each Session bound to a Workspace directory by `workspacePath`; Harness Adapters remain private implementation boundaries and are not exposed as lifecycle objects or third-party extension points. Callers explicitly enable a non-empty set of official Muha integrations through opaque Harness Registrations supplied by independently installable and versioned `@muha-sdk/*-adapter` packages, each of which owns its vendor dependencies; this keeps `@muha-sdk/core` free of vendor dependencies while preserving one integration per Harness Kind, and means supporting a new Coding Harness requires an official Muha adapter package. Runtime operations select an enabled integration by its stable public Harness Kind, such as `"codex"`, rather than by passing a Registration or Adapter object. A Runtime with no enabled Harness is rejected because integrations cannot be added after startup and such a Runtime could not manage an Agent Session. Runtime initialization is all-or-nothing: if any internal Adapter fails to initialize, Muha closes those already initialized, closes the Diagnostic Event Store, releases its process and data-directory guards, and returns no degraded Runtime.
