# SDK qualification and migration provenance

The first functional version was accepted against source
`8fa1a52aee74200e11c39e91c1ac7650bf31e1c4`. The migration source document baseline
is `1c59b2d48f14ba508d3dafb93bb2e4455cdba6a1`; runtime files are unchanged.
[Sorted SHA256 manifest](scripts/fixtures/sdk-runtime-sha256.json) maps the six packages only.
The former whole packages-tree fingerprint included private Orchestrator and
cannot identify this SDK tree. Raw evidence is retained privately.

| Harness | Accepted route | Actual version | Fixed real model |
| --- | --- | --- | --- |
| Codex CLI | native app-server | 0.159.2 | `gpt-5.6-luna` |
| OpenCode | v2 native serve | 2.0.11 | `opencode-go/deepseek-v4.1-flash` |
| Kimi | native web | 2.1.1 | `deepseek/deepseek-flash` |
| AGY | native CLI | 1.2.14 | `claude-sonnet-4-6` |
| Pi | patched SDK | 0.84.2 | text/non-image and both Pi/Pi roles: `opencode-go/deepseek-v4.1-flash`; image: `opencode-go/qwen3.8-flash` |

Codex/Luna reasoning text: three probes remained `NOT_TRIGGERED` (zero deltas);
first-version disposition is user-approved `WAIVED`, not PASS. The native stream
mapping and Profile remain intact. Consumers must tolerate absent reasoning and
use the terminal Turn Result plus final Assistant Message to determine completion.
Codex only detects effective `default_mode_request_user_input`, project over global,
and emits a non-blocking Node warning when false/unknown. Muha never enables the
feature or experimental API. AGY Sonnet effort selection is model-level `N/A`,
user accepted; the static Profile is unchanged. AGY and Pi retain their own limits.

The Official Harness Set is Codex, OpenCode, Kimi, AGY and Pi. Each immutable
Harness Capability Profile remains enforced; unsupported calls return
`UNSUPPORTED_CAPABILITY`. `harnessManaged` preserves native permission behavior.
Private Orchestrator's `HARNESS_CAPABILITY_MISMATCH` checks are tested separately.
Pi/Pi qualification completed 17 rounds/35 Turns under a 50-round cap, with one
provider connection failure recovered by the opted-in three-retry budget. Default
Turn Retry Policy is unchanged; network recovery is not a new feature claim.

Original controlled baseline: SDK 470 PASS / 2 opt-in SKIP, Pi 53 PASS; private
Orchestrator 108 PASS is not included in this SDK. Thirty-one frozen primary
commands exited zero, plus the separate three Codex reasoning probes above.

Migration acceptance uses clean `npm ci`, `npm run check`, isolated packed consumer
fixtures and package resources/permissions/licenses/dependency-closure contracts.
Diagnostic tarballs and their checksums are test evidence only. No package is published,
no consumer application is tested, and no paid real-model matrix is
rerun by this migration. Package metadata/navigation, workspace membership and
test organization change; runtime TypeScript, workers/loader, C sources, Pi patch
algorithm, routes, Profiles, defaults and pinned production dependencies do not.

Any future behavior/loading/dependency change must enumerate affected units,
cost and bounded real-model requalification, then obtain authorization before
reusing that unit's evidence. Public-history review, visibility approval, npm
scope/version/publication and Registry install/lockfile `npm ci` are later gates.
