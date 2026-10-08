# Muha SDK

Muha exposes five Coding Harnesses through one TypeScript control model while
preserving each Harness's own behavior. Performance-first means satisfying the
Muha contract, not preferring ACP, CLI or a particular transport.

This SDK repository contains six packages at `0.1.13`: [Core](packages/core/README.md),
[Codex CLI](packages/codex-adapter/README.md), [OpenCode](packages/opencode-adapter/README.md),
[Kimi](packages/kimi-adapter/README.md), [AGY](packages/agy-adapter/README.md),
and [Pi](packages/pi-adapter/README.md). Orchestrator is an independent private
project, not an SDK package or workspace.

The root workspace stays private; the six SDK packages carry public npm release
metadata. GitHub visibility, npm upload and Registry-install acceptance are
separate release gates. Diagnostic tarballs are test evidence; only a verified
publication candidate can enter the release workflow.

For an npm release, install Core and the Harness Adapters you use:

```sh
npm install @muha-sdk/core@0.1.13 @muha-sdk/pi-adapter@0.1.13
```

The five Adapters depend on the matching Core version. See the package READMEs
for examples, native authentication and Harness prerequisites.

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
`@earendil-works/pi-coding-agent@1.0.4`, not a global CLI or bundled dependency tree.
Real qualification commands are opt-in and must receive explicit budget approval.

Local plans and historical decisions live in ignored `docs/` directories;
private validation logs live in `.scratch/`. These files are not required for a
fresh checkout. `npm run check:repository` rejects tracked `docs/` paths, and CI
checks the committed tree before installing dependencies.

Start with [Core usage](packages/core/README.md), [qualification and exceptions](QUALIFICATION.md),
[contributing](CONTRIBUTING.md), [security](SECURITY.md), and the [domain glossary](CONTEXT.md).

## Release

The manual [SDK release workflow](.github/workflows/sdk-release.yml) first runs
the controlled checks on Ubuntu 22.04 / Node 22.20.0 / npm 11.15.0 and prepares a
checksummed six-package candidate from the reviewed main commit. Publication
requires its exact preparation run ID and `release.json` SHA256; it downloads
those original tarballs and publishes Core first with npm provenance and the
`candidate` tag. It stops on upload/readback errors so an immutable version is
never retried blindly.

Core alone, Core plus each Adapter, and all six packages are then installed from
the public Registry with empty caches on the supported Node floor and LTS. Their
Registry integrity, runtime resources, ESM/TypeScript contracts, dependency trees,
lockfile `npm ci` and owned lifecycle fixtures must pass before all `latest` tags
are promoted. The source tag and GitHub Release follow that acceptance.

First-publication authentication uses the short-lived `NPM_PUBLISH_TOKEN` Actions
secret with package/scope publishing rights. Once packages exist, trusted npm
publishing is configured for the next actual release window; it is not inferred
from a local npm login or an organization-management permission.
