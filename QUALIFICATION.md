# SDK qualification and migration provenance

The first functional version was accepted against source
`8fa1a52aee74200e11c39e91c1ac7650bf31e1c4`. The migration source document baseline
is `1c59b2d48f14ba508d3dafb93bb2e4455cdba6a1`; the unchanged Harnesses retain that baseline. Pi 1.0.4 received separately authorized bounded requalification on 2026-10-08.
[Sorted SHA256 manifest](scripts/fixtures/sdk-runtime-sha256.json) maps the six packages only.
The former whole packages-tree fingerprint included private Orchestrator and
cannot identify this SDK tree. Raw evidence is retained privately.

| Harness | Accepted route | Actual version | Fixed real model |
| --- | --- | --- | --- |
| Codex CLI | native app-server | 0.159.2 | `gpt-5.6-luna` |
| OpenCode | v2 native serve | 2.0.11 | `opencode-go/deepseek-v4.1-flash` |
| Kimi | native web | 2.1.1 | `deepseek/deepseek-flash` |
| AGY | native CLI | 1.2.14 | `claude-sonnet-4-6` |
| Pi | patched SDK | 1.0.4 (internal dependency packages 1.1.0) | text/non-image: `opencode-go/deepseek-v4.1-flash`; image: `opencode-go/qwen3.8-flash` |

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
The historical Pi 0.84.2 / private Orchestrator Pi/Pi qualification completed 17 rounds/35 Turns under a 50-round cap, with one
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
test organization change; the four other Harness runtimes, Core, C sources, routes and Profiles remain unchanged. The separately authorized Pi 1.0.4 update changes its input patch, extension preflight adaptation and production dependency closure; it requires new controlled and bounded real-model evidence before publication.

Any future behavior/loading/dependency change must enumerate affected units,
cost and bounded real-model requalification, then obtain authorization before
reusing that unit's evidence. Public-history review, visibility approval, npm
scope/version/publication and Registry install/lockfile `npm ci` are later gates.

## Pi 1.0.4 requalification (2026-10-08)

The authorized runtime candidate is `3385d373ac4bb5a5257fe52906192349d990b3e7`.
Only Pi's verified input-patch build, SDK worker and extension preflight bridge
change among the 64 runtime resources. Core and the four other Harness runtime
digests retain their accepted source; their paid matrix was not repeated.

Controlled verification: SDK 480 PASS / 2 opt-in SKIP; Pi 58 PASS. A cold-cache
consumer installed Core and Pi with normal install flags and no root overrides,
then initialized and closed its owned Runtime. A separate npm 11.16.0 run
explicitly approved only reviewed dependency versions in the consumer project,
executed their install hooks, deleted node_modules and reproduced its lockfile
with npm ci. These approvals belong to the consumer; dependency manifests do
not grant npm script approvals. The production registry advisory
audit reported zero vulnerabilities. License texts, exact install hooks, packed
workers and native ABI guards were checked independently.

Real qualification used 17 attempts under the approved 20-attempt, 120-second
per-attempt, 45-minute, concurrency-one limits. Native retries and cache warming
were disabled in the owned qualification profile. Text and reasoning deltas,
usage, native tools/file effects, Workspace Skills, model/effort selections,
listing and new-Runtime history, externally created native history, interleaved
file/base64 and pure-image input, image pixels and persisted order, interruption,
provider rejection/recovery, SDK process loss/group reclamation and private
host-owned diagnostics passed. Attempt 16 failed with native `Connection error.`;
the explicitly counted reserve attempt 17 recovered. Failure evidence remains
private; it is not rewritten as an initial success.

The runner's missing native route on an external Session Reference was corrected
without resetting its attempt ledger. No private Orchestrator or Pi/Pi grilling
was rerun; its old SDK conclusion remains historical. GitHub/npm publication and
cold public-Registry consumer acceptance are separate pending release gates.

Release preparation additionally passed SDK 482 tests / 2 opt-in skips and all
58 Pi controlled tests, including publication/provenance rejection cases. Only
the test runner concurrency and readiness/cancellation fixture timing conditions changed;
qualified non-Pi runtime digests and the dependency lockfile remain unchanged.

## Pi lifecycle requalification (2026-10-09)

Release CI exposed a race between detached Bash creation and the SDK's process
identity notification. A deterministic scheduling pause reproduces the leak.
Pi now starts its SDK under the unchanged Linux subreaper shipped by its exact
Core dependency, using separate ownership control and native Node IPC. Kernel
adoption covers detached children even when the SDK dies before notifying Muha.
Close succeeds only after the owner proves it has no children; helper loss or
cleanup timeout reports failure without claiming reclamation. Core, the C helper,
other Harnesses, input semantics and the dependency lockfile remain unchanged.

The earlier 17-attempt receipt qualifies the preceding Pi source. The updated
lifecycle candidate `6a1983a83a62a0ed8d03ef9ed441b5084074b4e2` received
separately authorized real-model verification using
`opencode-go/deepseek-v4.1-flash`. All four planned attempts passed within the
five-attempt, 120-second-per-attempt, ten-minute, concurrency-one limits, taking
about 26 seconds. No reserve attempt was used; native retries and cache warming
were disabled. Native Bash interruption, continuation in the same Session,
active SDK loss with fatal Runtime closure and detached-process reclamation,
and history recovery in a new Runtime passed. Both host-owned diagnostic stores
contain SDK callbacks; temporary credential copies were removed and the original
credentials and 17-attempt ledger remained unchanged.

Controlled verification: SDK 483 PASS / 2 opt-in SKIP, Pi 60 PASS. The same runtime
source passed all three GitHub Node jobs (22.20.0, LTS and current), including the
fixed spawn-pause regression and ownership-helper loss reporting. Only Pi units
listed in the latest manifest entry changed; the other Harnesses, Core, C helper,
input patch and dependency lockfile retain their accepted digests. Publication
requires the latest Pi entry to pass; a historical PASS cannot qualify a newly
pending runtime. Public Registry acceptance remains a separate release gate.
