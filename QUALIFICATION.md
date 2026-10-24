# SDK qualification and migration provenance

## Native model catalog development candidate (2026-10-24)

This candidate adds Session-free `runtime.listModels({ harness, workspacePath })`
to Core and all five official Adapters. Model selection behavior is unchanged:
Codex, OpenCode, Kimi and Pi retain idle `setModel`; AGY still supports selection
only at create/resume. The catalog reports native selectable chat models, not a
successful inference or quota guarantee.

Affected units include Core's catalog boundary, static Profile and command
supervision; Codex/Kimi catalog readers shared with existing validation;
OpenCode's V2 catalog projection; Pi's temporary SDK availability worker;
and AGY's bounded catalog parser and owned finite CLI query. The runtime
resource manifest pins 71 resources and preserves every historical receipt.
New per-unit entries on both Linux and Windows remain PENDING with zero real
attempts. They prevent publication from inheriting an older source's PASS.

Only controlled CLI/loopback-provider tests, typechecking and repository checks
are authorized here. Real inference, Windows runtime acceptance, publication
and consumer-application validation require their existing separate decisions.
The proposed bounded real regression scope is model-list/selection agreement,
affected model/effort validation, ordinary failure recovery, and temporary
query/worker reclamation, with explicit source, platform and budget approval.
Historical qualifications below retain their actual source and platform scopes.

## Windows qualification closure (2026-10-22)

AGY and the independent shared-Core Windows platform gate now pass on source
`de380ad6dad6ea732fa964c0af77b90485f6fb79`. This supersedes only their earlier
PENDING platform entries; the dated evidence and failures below remain historical.
All five official Adapters now have complete native Windows qualification with
their recorded models, source scopes and accepted exceptions.

AGY CLI 1.4.5 / native Windows x64 / Node 22.23.3 used
`claude-sonnet-5-5-low`, concurrency one, zero Muha retries, a 120-second
per-attempt cap and a separately confirmed 20-attempt / 90-minute budget.
It used 19 attempts: 18 required cases passed; one retained fixture failure
incorrectly required nonempty text after native permission denial. AGY had
delivered an explicit completed empty Assistant Message, which is valid under
the existing contract and is distinct from a missing or unfinished message.
The corrected case passed with native `denied_actions`, an error Tool result,
no file write and matching terminal/result. Three other fixture setup failures
occurred before inference and remain recorded separately.

Passed real cases cover ordered text, message deltas and usage, multi-Turn
memory, same- and new-Runtime resume, invalid model selection and recovery,
native file Tools, Skill payloads shared across independent native Projects,
and `autoApprove` to `harnessManaged` policy transitions without editing native
rules. Real native Tool interruption, Session close, CLI loss and Runtime close
each reclaimed the owned Tool and detached child; interruption allowed immediate
continuation, while fatal CLI loss required an explicit new Runtime. Sonnet 5.5
also accepted `effort=low` at creation and resume with `selectedOnly` observation;
idle effort/model setters remain unsupported. This does not rewrite the
historical Sonnet 4.6 effort limitation or claim every effort value works.

An independent post-close audit re-read all 18 successful cases and 152 native
semantic records, checked terminal payloads, SQLite integrity and SID-based
private NTFS ACLs. Native permission modes changed from `always-proceed` to
`request-review` under the same reference. No credentials were copied; native
records passed credential-field and bearer-pattern checks. Exact credential-value
scanning was unavailable at the three known plaintext credential paths and is
not claimed. Successful phase before/after native settings fingerprints matched.
Launching the same Windows CLI from a WSL UNC working directory returned a
misleading sign-in error; model inventory and qualification succeeded from
native Windows drive directories without reauthentication or auth changes.

Shared Core was closed through an explicit evidence audit, not automatically
from Adapter PASS flags. Its native Windows focused suite passed 130/130 with
zero skips, covering Runtime guards/rollback/fatal closure, Session and Turn
conformance, profile enforcement, retry ownership, Workspace operations, private
store/lease/fault handling and actual native helper ownership/ACL behavior.
Both six-job Linux/Windows CI matrices passed at the qualified source. Every
Core and relevant Adapter resource was compared with each Harness's accepted
source: Codex `9faf0bf`, OpenCode/Kimi `6103a01`, Pi `5090dc7`, and AGY
`de380ad`. The unchanged resources preserve earlier real evidence; controlled
failure injections are not described as new provider calls. The existing Luna
reasoning omission and helper-loss reclamation boundaries remain unchanged.

No runtime resource or external dependency changed to obtain this acceptance.
The subsequent seven-package 0.1.17 version/internal-pin update is metadata-only;
the qualification receipts retain the actual tested source and lockfile.
Qualification eligibility does not imply a main merge, formal dual-platform
candidate, npm upload, Registry install/lockfile replay or consumer acceptance.

## Bounded follow-up acceptance (2026-10-21)

Pi, Codex, OpenCode and Kimi now have accepted native Windows evidence. Pi also
passed its separately authorized complete Linux SDK matrix; OpenCode and Kimi
received affected Linux regressions while preserving unchanged historical
capability evidence. This is not an all-Harness Windows or release acceptance:
AGY is explicitly deferred for exhausted quota, and shared Core's complete
Windows qualification remains PENDING until the platform gate is closed.

| Harness | Native Windows model selection | Actual attempts / original limit |
| --- | --- | --- |
| Codex 0.163.0 | `gpt-6-luna` | 20 / 20 |
| OpenCode 2.0.28 | text `opencode-go/deepseek-v4.1-flash`; images `opencode-go/qwen3.8-flash` | 20 / 20 |
| Kimi 2.1.1 | `deepseek/deepseek-flash` | 20 / 20 |
| Pi SDK 1.2.0 | text `opencode-go/deepseek-v4.1-flash`; images `opencode-go/qwen3.8-flash` | 16 / 20 |

The three new CLI matrices used concurrency one, zero Muha retries and a
120-second per-attempt cap. User-approved wall-clock renewals retained every
attempt; the final renewal excludes tool-approval waiting. Original failed
fixtures and untriggered cases remain recorded, not erased or counted as PASS.
The 16 required cases per CLI are assembled from their successful receipts,
with source scopes preserved where only an independent Adapter unit changed.

Codex passed a real typed Question and caller answer, MCP proof, all four
permission decisions, native file/Skill effects, model/effort, image inputs,
history and interruption/continuation. Only an isolated test `CODEX_HOME`
enabled `default_mode_request_user_input` and retained the user's existing
Windows sandbox setting; original configuration/auth digests remained unchanged
and the temporary authentication/configuration copies were removed. Muha still
only detects the feature and warns. Luna reasoning remains an accepted omission,
not a fabricated reasoning stream. A post-close independent audit inspected
1,094 native records and checked credential exclusion.

OpenCode's final source passed both image formats on Windows 2.0.28 and Linux
2.0.11. Windows permission tests use an owned Git project to avoid sharing native
saved-approval state with unrelated non-Git temporary directories; no user rule
was rewritten. Caller allow/deny, native deny-all, typed Question and immediate
post-interrupt continuation passed. Native diagnostic records contained no
scheduled retries. Linux used the original three-attempt limit: one retained
pre-provider structural failure, then two successful fixed-source image Turns.

Kimi's fixed cancellation path passed real interruption followed immediately by
continuation on both platforms. Linux used two authorized Turns. Windows used
the last two original attempts in a fresh Session after a history-influenced
model response did not attempt the requested Tool. Independent native-record
inspection confirmed that response belonged to the newly accepted promptId,
not an older queued prompt. That untriggered case is not counted as an
interruption PASS. All other capability cases retain their
verified earlier source scope. Temporary native Workspace trust was revoked
and unregistered after each qualification run.

Codex's unchanged runtime qualified on `9faf0bf99a997a57bdc24d7f563d3be823f922ac`;
the affected OpenCode and Kimi runtime resources qualified on
`6103a0136ef4e8d5227f38d8c4801368f5082048`. Pi retains its source recorded below.
No version bump, npm upload, Registry acceptance or consumer application test
is implied by these results.

## OpenCode canonical media correction candidate (2026-10-21)

Native Windows OpenCode 2.0.28 admitted the image Turn but failed before provider
dispatch with `Muha ordered image changed before model dispatch`. The hook read
the retired top-level `mediaType/data` fields instead of the canonical
`part.media.source` Asset documented in the fixed upstream implementation:
[context lowering](https://github.com/anomalyco/opencode/blob/v2.0.28/packages/core/src/session/runner/to-llm-message.ts)
and [Media Asset](https://github.com/anomalyco/opencode/blob/v2.0.28/packages/ai/src/media.ts).
This was not a model-color hallucination. The correction accepts canonical inline
base64/byte Assets, preserves native objects and still checks MIME, SHA256,
image counts, indices and text order. The first affected Linux probe exposed
that installed v2.0.11 still uses the top-level inline shape described in its
[fixed upstream source](https://github.com/anomalyco/opencode/blob/v2.0.11/packages/core/src/session/runner/to-llm-message.ts).
Both V2 wire shapes are now checked as disjoint alternatives: invalid canonical
Assets never fall back to top-level data, and mixed/ambiguous representations,
URL/ref assets and changed bytes/MIME fail closed. This preserves the previously
accepted V2 version rather than adding another integration route.

The one affected OpenCode runtime resource passed the bounded Linux image
regression and Windows follow-up above. Historical PENDING records remain below
their later PASS receipts. No dependency lock was changed for this correction.
AGY and shared Core's complete Windows gate remain independently pending.

## Kimi native cancellation settlement candidate (2026-10-21)

Windows real-model qualification observed an acknowledged REST abort before the
native Tool result and `turn.ended`. Immediate continuation consequently received
the previous Turn's tail and failed with `Turn event preceded turn.started`.
The Adapter now keeps cancellation pending until native terminal settlement,
using its bounded shutdown timeout; acknowledgement alone is not evidence that a
Session can be reused. A controlled delayed-ack/late-Tool regression covers
immediate continuation without replay. The authorized Linux and Windows affected
real-model regressions above now pass; earlier successful capabilities retain
their original resource and source scope. No consumer or release acceptance is
implied, and temporary Codex feature configuration does not alter Adapter behavior.

## Pi SDK 1.2.0 dual-platform requalification (2026-10-20)

Separately authorized real-model qualification passed on source
`5090dc7e396f8819d06b45514599eff130a0526e`, with the unchanged 69 pinned
runtime/build/license resources and lockfile digest
`eccb9324be5a71cbce7470b58d50d58555f7cdbf8e86e33aa048acfde081ec7e`.
Linux x64 / Node 24.18.0 used 18 actual attempts, including two retained
qualification-fixture failures; native Windows x64 / Node 22.23.3 used 16.
Both used the exact SDK 1.2.0, `opencode-go/deepseek-v4.1-flash` for text and
`opencode-go/qwen3.8-flash` for images, concurrency one, Muha retries and native
retry settings disabled, and a shared 40-attempt limit with 20 per platform and 120 seconds per
attempt. The original 90-minute wall-clock window expired during tool approval
waits; the user explicitly renewed time without resetting attempt counts.

Passed cases cover streamed text/reasoning/usage, multi-Turn and new-Runtime
history, native file Tools, workspace Skills, model/effort at create/resume/idle,
ordered file/base64 and pure-image input, native listing and external SDK history,
actual provider rejection and recovery, interruption/continuation, and SDK loss
with owned native Tool reclamation and explicit new-Runtime recovery. Post-close
audits observed 759 Linux and 1,237 Windows native subscription records, checked
credential exclusion and removed temporary credential copies. Native history
retained `image/text/image/text` and image-only order. No live diagnostic reader
or new public SQL interface is implied.

Linux fixture failures came from matching the supervisor's worker argument as
another SDK process and then reading an old PID marker; both refused to signal
an unproven target. The corrected unique-marker test passed within the original
attempt limit. A no-Turn, expired-budget preflight Runtime correctly had no
subscription events; independent post-close aggregation verified actual model
hosts without additional inference. Original failures remain in private evidence.
No qualified runtime source was changed to obtain these results.

Pi now passes on both recorded platforms. This does not qualify the other four
Windows adapters or the complete shared-Core matrix. Their latest pending entries
continue to block publication; AGY's new paid testing is explicitly deferred by
the maintainer because its quota is exhausted. Dual-platform source-bound
assembly has passed a local rehearsal using real Linux and Windows builds, but
Registry publication and complete cold-install acceptance remain separate gates.

## Native Windows x64 candidate (2026-10-15/18)

This branch adds a native Windows ownership helper, private NTFS diagnostic
storage checks and a Windows pipe transport for Pi. Earlier Linux qualification
records below retain their original source and platform scope. The candidate's
full Windows qualification at that snapshot remains PENDING. The Pi and assembly
follow-up above supersedes only those two pending work items, not other adapters'
full Windows qualification or Registry acceptance.

The user authorized real Windows model tests with the repository Profiles.
On Windows 11 x64 / Node 22.23.3, Codex 0.162.1 (`gpt-5.6-luna`), OpenCode
2.0.28 (`opencode-go/deepseek-v4.1-flash`), Kimi 2.1.1
(`deepseek/deepseek-flash`) and the pinned Pi SDK 1.0.4
(`opencode-go/deepseek-v4.1-flash`) each passed three actual Turns: text,
same-Session continuation, and a native file Tool after Session resumption in a
new Runtime. Every accepted Turn had one completed terminal, host-owned native
diagnostic records were present, and Runtime close succeeded. These twelve
Turns used concurrency one, no Muha retries, a 60-second per-attempt deadline
and a three-attempt per-Harness limit within a 30-minute overall bound.

AGY 1.3.5 rejected the fixed `claude-sonnet-4-6` model during Session creation,
before any model Turn. Following explicit user authorization, AGY's native
`claude-sonnet-5-5-low` selection passed three bounded Windows Turns on source
`fc5225501cab1661bb8da15a237b4652cf03365d`; the CLI version checked immediately
afterwards was 1.3.6. The dotted alias `claude-sonnet-5.5` was rejected before
any Turn. This smoke does not replace the historical fixed-model Profile.

The paid receipt identifies the preceding candidate snapshot. Subsequent
Windows path/environment, private declaration and packaging fixes receive
controlled verification; the paid smoke was not repeated on the final source.
This candidate follows main's Pi SDK 1.2.0 migration and rebased input patch.
The earlier Windows Pi SDK 1.0.4 smoke remains historical. A separately
authorized Pi SDK 1.2.0 batch passed three Windows Turns on source `fc52255`,
using `opencode-go/deepseek-v4.1-flash` / low effort. Both new batches verified
the earlier conversation marker as well as the file contents after resumption
in a fresh Runtime, one terminal per Turn, native diagnostics and owned close.
They used three Turns per Harness, 60 seconds per Turn, concurrency one and
zero retries. Private receipts stay in ignored paths. Bounded smoke does not
qualify every declared Windows capability or a
consumer application, and no Registry publication was performed.

The preceding Windows 11 x64 candidate `fc52255`, including Pi SDK 1.2.0,
passed `npm run check`: repository index policy, typecheck, native builds,
602 SDK contracts (24 historical/opt-in skips), and 63 Pi contracts (one
Linux-specific process-observation skip). The controlled examples, package
isolation, umbrella cold install and lockfile replay passed. Earlier npm
Registry timeout failures remain in private receipts; this final run had zero
failures. Its Linux CI matrix passed, but all three Windows CI versions
reported 527 passing / 75 failing / 24 skipped contracts. The follow-up
candidate fixes canonical temporary Workspaces and dependency-audit roots,
canonical fixture identities, Windows artifact replacement and cold-install
time bounds. A Windows control-channel close acknowledgement prevents a
concurrent close write from discarding the owner's cleanup proof after native
exit; helper loss and missing proof still fail. Core/AGY/OpenCode runtime
changes receive new controlled checks;
the paid receipts above retain their earlier source scope and were not rerun.
Full Windows capability qualification and multi-platform assembly remain pending.

## Preserved qualification history

The `@muha-sdk/muha` entry package in 0.1.15 re-exports the same public Core
API and five official Adapter factories. Seven packages now form the SDK release;
the Official Harness Set remains unchanged. Entry loading, one-dependency installs,
README examples and lockfile replay receive controlled consumer checks. The 64
qualified Core/Adapter runtime resources and external dependency locks retained
their accepted digests for that packaging change; it did not repeat the paid model matrix.
The later Pi 1.2.0 test-repair candidate described below changes its patch and
dependency closure and is not qualified by that historical packaging evidence.
Public Registry acceptance is recorded separately in each
[GitHub Release](https://github.com/Gao-Sijie/muha/releases).

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

These are accepted historical versions. The current Pi 1.2.0 controlled candidate
below is not yet a real-model-qualified replacement for the Pi row.

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

## Pi codemode dependency declaration (2026-10-14)

The user selected a direct `@earendil-works/pi-codemode: >=1.0.4` dependency
without an upper bound for the Pi Adapter. The exact Pi SDK remains 1.0.4,
and the development lockfile still selects codemode 1.1.0. No runtime resource,
input patch, installed dependency version or other Harness changes in this step.
Historical real evidence qualifies only its recorded source and dependency
combination, not every release admitted by this open-ended declaration.

At that declaration-only stage the SDK's own codemode range was unchanged; this declaration cannot override
its native dependency resolution. Current independent-installation failures
are not waived by choosing this range. A newly resolved combination must pass
installation, initialization and the affected controlled contracts, and obtain
separate authorization for bounded real-model requalification before its real
behavior is described as accepted. No new paid matrix or npm publication is
authorized by this declaration change.

## Pi 1.2.0 controlled test-repair candidate (2026-10-14)

Fresh installation reproduced SDK 1.0.4 with native Pi component packages
1.2.0. SDK 1.0.4 imports `MCP_TYPESCRIPT_PREAMBLE` and
`mcpStructuredContentSchema`, which codemode 1.2.0 no longer exports; the SDK
failed to load before any Turn or model call. This is a dependency API mismatch,
not a provider connection problem, and retries cannot repair it.

The candidate pins the official SDK to 1.2.0 and retains the user-selected
direct `pi-codemode: >=1.0.4` range with no upper bound or consumer overrides.
Its development lock selects the native Pi 1.2.0 suite. The verified ordered-input
patch now carries content order privately through native run preparation,
preserving native image normalization, explicit transformations, expansion,
custom messages and lifecycle. SDK 1.2.0 sets its busy state before notifying
preflight acceptance; the candidate keeps that callback inside the SDK's native
finalizer so rejection or interruption releases the state without a model request.
Ordered prompts deferred from native settled callbacks keep their original order.
SDK version/source/patch checks and strict anchor
validation remain enforced; there is no unpatched fallback. The upstream v1.2.0
MIT license body matches the shipped text apart from its final newline.

The 64-resource manifest records the current controlled candidate and preserves
all historical PASS receipts. Only Pi's input-patch build changes among those
resources; its dependency lock and exact license-evidence mapping also change.
Core and the four other Harness runtime resources retain their accepted digests.
The latest Pi qualification is `PENDING`, not PASS, and the publication guard
requires the current SDK version so an older accepted SDK cannot authorize it.

This task authorizes controlled test repair, not paid model calls or publication.
On Node 24.18.0 / npm 11.16.0, lockfile `npm ci`, typecheck and full
`npm run check` passed: SDK 580 PASS / 2 existing opt-in SKIP, Pi 64 PASS.
Fresh Core/Pi, five-Adapter and umbrella installs, consumer lockfile replay,
four new ordered-input/preflight regressions, owned-process reclamation,
license evidence and source/patch integrity were exercised without real models.
Before real evidence can be reused, separately authorize bounded Pi-only
requalification of text/reasoning/usage, native tools and Skills, model/effort,
ordered/pure images and persisted history, interruption/SDK loss and cleanup.
No other Harness matrix or consumer application validation is implied.

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

## Codex empty web-search display query fix (2026-10-11)

The native `webSearch` display item's required string `query` may be empty;
it is not necessarily the actual search request text. Both started and completed
Tool mappings now accept that empty string and preserve native query, action and
results. Missing/non-string queries and unrelated tool input validation remain
strict. Native execution, bridge routes, Profiles and dependencies are unchanged.

Only `packages/codex-adapter/src/codex-process.ts` changes among the 64 pinned
runtime resources. Its new digest identifies the repaired runtime; the preceding
Codex model matrix remains historical. Controlled cases use the reported Codex
0.162.1 started-item shape and synthetic completed snapshots, including a
successful native Turn and same-Session continuation.

Controlled verification passed on Node 24.18.0 / npm 11.16.0: all six new
web-search regressions, 64 Codex/source-integrity contracts with two existing
opt-in skips, typecheck, and full SDK 495 PASS / 2 opt-in SKIP plus Pi 60 PASS.
An initially missing SDK entry workspace link was restored with the unchanged
lockfile's `npm ci`; the failed pre-install typecheck is retained in private
receipts rather than presented as a first-attempt PASS.

The user separately authorized `gpt-6-luna` for this narrow repair, under three
attempts, 120 seconds per attempt, ten minutes overall and concurrency one.
Source `cd12bc4fa57062815a0dfe604b321cd200f8a0c9` on Codex CLI 0.162.1 passed
both actual attempts in 24.006 seconds: native web search emitted one empty-query
started item, completed successfully with lossless public input/output, and the
same Session completed its next Turn. Exactly one terminal per Turn and owned
cleanup passed; the reserve attempt was unused. Empty completed queries were
not observed in this real probe; that mapping is covered by controlled fixtures,
not presented as an observed native completion. No other Harness, full model
matrix or consumer application workflow was rerun. Seven-package 0.1.16 Registry
publication and lockfile installation acceptance remain the separate release gate.
