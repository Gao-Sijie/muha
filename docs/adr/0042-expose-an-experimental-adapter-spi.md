---
status: superseded by ADR-0051
---

# Expose an experimental Adapter SPI

Muha V0.1 exposes a strongly typed experimental Adapter SPI from `@muha-sdk/core/adapter`, accepts official and third-party Harness Registrations, and uses an open string Harness Kind while reserving stable names for its official integrations. Every registered Adapter must obey Core Conformance and Core validates its observable protocol, but only the Codex, Claude Code, OpenCode, and Kimi Adapter packages receive official support; the SPI is not a lifecycle object and does not promise compatibility across minor releases until a later stability decision. This supersedes ADR-0026's private-Adapter boundary in favor of implementation, fake-Adapter, and integration-author convenience.
