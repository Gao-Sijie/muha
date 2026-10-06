# Muha SDK

Muha exposes five Coding Harnesses through one TypeScript control model while
preserving each Harness's own behavior. Performance-first means satisfying the
Muha contract, not preferring ACP, CLI or a particular transport.

This SDK repository contains six packages at `0.1.13`: [Core](packages/core/README.md),
[Codex CLI](packages/codex-adapter/README.md), [OpenCode](packages/opencode-adapter/README.md),
[Kimi](packages/kimi-adapter/README.md), [AGY](packages/agy-adapter/README.md),
and [Pi](packages/pi-adapter/README.md). Orchestrator is an independent private
project, not an SDK package or workspace.

The repository and all packages remain private during migration. No package is
published by this cutover; npm publication and public visibility each require
separate approval and acceptance. Temporary diagnostic tarballs are tests only,
not consumer delivery or Registry-install proof.

## Develop

Supported hosts: Node.js `>=22.20.0`, Linux x64 glibc (including matching WSL2).
Builds require a C compiler and `readelf`; installing prebuilt packages does not.
CI uses Ubuntu 22.04 as its qualified compiler host and rejects native artifacts
requiring glibc above 2.28. Do not raise this ABI floor to accommodate a newer runner.

```sh
npm ci
npm run clean
npm run build
npm run typecheck
npm run check
```

Controlled tests need no model subscription. Native CLI use requires independently
installed/authenticated Harnesses on `PATH`; Pi uses its exact normal SDK dependency
`@earendil-works/pi-coding-agent@0.84.2`, not a global CLI or bundled dependency tree.
Real qualification commands are opt-in and must receive explicit budget approval.

Start with [Core usage](packages/core/README.md), [qualification and exceptions](docs/testing/sdk-qualification.md),
[contributing](CONTRIBUTING.md), [security](SECURITY.md), and the [domain glossary](CONTEXT.md).
