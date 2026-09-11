# Contributing to Muha

Thanks for helping improve Muha.

## Development setup

Muha requires Node.js `>=22.20.0` on Linux x64 glibc (WSL2 is supported).

```bash
npm install
npm run check
```

The public repository contains the embeddable SDK only: Core plus the official Codex, OpenCode, and Kimi Code adapters. Please keep changes within that product boundary unless an issue explicitly proposes a public API expansion.

## Pull requests

- Keep public APIs small and typed.
- Preserve native Harness semantics rather than inventing cross-Harness equivalence.
- Add or update public contract tests for packaging or API-surface changes.
- Run `npm run check` and `npm run pack:dry-run` before opening a PR.
- Do not commit credentials, native Harness transcripts, prompts, tool payloads, or diagnostic databases.

For bugs, include the Muha package version, Node.js version, OS/runtime, Harness name and native Harness version when available. Do not include secrets or full Diagnostic Event Store contents.
