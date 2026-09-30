---
status: superseded by ADR-0061
---

# Support only official Adapters in V0.1

Muha V0.1 supports only the Codex, Claude Code, OpenCode, and Kimi Adapter packages and keeps Harness Kind as their closed string union. Each official package returns an inactive, opaque Harness Registration whose lazy factory Core invokes only during Runtime initialization, so Core owns creation, rollback, and closure and callers never pass an already-started Adapter instance. The official packages may consume Adapter implementation types that remain technically visible in published artifacts, but Core exposes no supported `defineHarnessAdapter` entry point, third-party registration, extension documentation, compatibility promise, or public Fake Adapter; technical visibility alone does not make the protocol a V0.1 extension surface. This supersedes ADR-0042's experimental third-party SPI.
