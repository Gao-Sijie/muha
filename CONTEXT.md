# Muha SDK

Muha SDK exposes multiple coding harnesses through one programming model while preserving the capabilities and behavior that are specific to each harness.

## Language

**Muha SDK**:
Short for `muli-harness-sdk`: a TypeScript library that gives local and CI automation a common control model for selecting and driving a Coding Harness while preserving harness-specific capabilities.
_Avoid_: Hosted agent service, multi-tenant gateway, harness replacement

**Muha Release**:
A lockstep, checksummed SDK artifact set containing the Muha SDK Entry Package, Muha Core and all five official Harness Adapters, identified by one SemVer and an explicit delivery manifest. Its publication and consumer acceptance apply to all seven packages; Orchestrator has an independent private release.
_Avoid_: Individual package release, staggered Adapter release, Orchestrator release

**Muha SDK Entry Package**:
The complete SDK distribution entry that exposes Core's public control model and all five official Harness Registrations together. Installing it does not enable a Harness; each Runtime explicitly chooses its Registrations.
_Avoid_: Harness, automatic runtime, native tool installer

**Muha Runtime**:
The explicit process-local owner of shared Muha resources and the Harness instances created from them.
_Avoid_: Global singleton, orchestrator, hosted runtime

**Runtime ID**:
A Core-generated UUID identifying one Muha Runtime instance for diagnostics, default data-directory isolation, and Native Event Record attribution.
_Avoid_: Caller-defined name, resumable identity, Session identity, application ID

**Coding Harness**:
An agent runtime that combines a model with an agent loop, coding tools, workspace access, permissions, and conversation state.
_Avoid_: Model provider, LLM API, chatbot

**Harness Adapter**:
Muha's complete implementation boundary for one Coding Harness, encompassing native Workspace configuration and translation of its sessions, events, controls, and failures into Muha concepts. Its implementation protocol may be visible to consumers but is neither a public lifecycle object nor a supported third-party extension point in V0.1.
_Avoid_: Model adapter, provider shim, lifecycle object, public plugin API

**Performance-first**:
Muha's first-version admission principle: choose each Harness Integration Route by truthful conformance to the Core Kernel and its declared Harness Capability Profile, without preference or quota for ACP, CLI, serve, or SDK. Here performance means fulfillment of Muha's behavior contract, not latency or throughput.
_Avoid_: ACP-first, CLI-first, protocol quota, speed-first, automatic cross-route retry

**Harness Integration Route**:
An identified, Muha-selected way for a Harness Adapter to fulfill its declared behavior through ACP, native integration, or a verified combination, distinct from the native Session identity and from any individual transport.
_Avoid_: Harness Kind, caller-selected protocol, transport, automatic fallback

**Harness Registration**:
An opaque, inactive description of one official Harness Adapter, produced by its Muha Adapter package and carrying its immutable Harness Capability Profile plus everything Core needs both to create its live runtime component and to configure its native Workspace files.
_Avoid_: Live Adapter instance, third-party plugin, Runner, Workspace object

**Official Harness Set**:
The closed set of Harness Adapters that one Muha version commits to support, independent of which packages are installed or which Harnesses a Runtime enables.
_Avoid_: Installed Adapters, enabled Harnesses, dynamic registry, discovered plugins

**Harness Kind**:
The stable public identity of one of Muha's official Coding Harness integrations—Codex, OpenCode, Kimi Code, Pi, or AGY—used to select and route its operations.
_Avoid_: Adapter Kind, adapter instance ID, account profile, model provider

**Harness Model**:
A Coding Harness's native model identifier selected by a live Agent Session handle for its subsequent Turns, with no cross-Harness naming or behavioral equivalence.
_Avoid_: Portable model, Muha model, normalized model ID

**Harness Effort**:
A Coding Harness's opaque native, model-associated tuning selection carried by a live Agent Session handle, with no Muha-defined semantics or cross-Harness naming or behavioral equivalence.
_Avoid_: Reasoning level, normalized effort, portable effort

**Agent Session**:
A process-bound Muha handle representing a stateful conversation owned by a Coding Harness and immutably bound to one Workspace, for which Muha Core permits at most one active Turn. Closing the handle does not delete the native conversation.
_Avoid_: Chat completion, request, Session Reference, Listed Session

**Workspace**:
The canonical absolute local directory path, resolved through symbolic links once the directory exists, that owns project-scoped Skills and MCP configuration and to which an Agent Session is immutably bound. It is a domain role represented publicly as `workspacePath`, not a Muha-owned object or lifecycle resource.
_Avoid_: cwd, Git repository, sandbox, session configuration, Workspace object

**Session Reference**:
A JSON-safe identity pointing to an Agent Session owned and persisted by its Coding Harness, binding its Harness Kind, native session identity, canonical Workspace, and the explicit, Muha-selected Harness Integration Route needed for resumption.
_Avoid_: Portable session, Muha session record, transcript

**Listed Session**:
A point-in-time, JSON-safe native listing entry containing a Session Reference plus only an optional Harness-supplied title and optional UTC RFC 3339 creation and update timestamps.
_Avoid_: Session Summary, Agent Session, transcript summary

**Turn**:
One user input and the resulting agent activity within an Agent Session, ending in completion, failure, or interruption.
_Avoid_: Session, message

**Turn Attempt**:
One private Harness execution of a Turn Input within an accepted Turn. A Turn may contain multiple sequential Turn Attempts when its Agent Session has an enabled Turn Retry Policy; Turn Attempts have no public identity, handle, event stream, or result.
_Avoid_: Turn, retry Turn, public attempt, Session restart

**Turn Retry Policy**:
An opt-in, process-local Agent Session run policy that gives each accepted Turn a fresh bounded budget for retrying eligible Harness failures as additional Turn Attempts. It is supplied again when creating or resuming a Session and is not part of Session Reference or native Session persistence.
_Avoid_: Adapter retry, Session retry, persistent retry setting, retry count on Turn Input

**Turn Input**:
A non-empty ordered list of JSON-safe text and image content parts submitted to `AgentSession.startTurn`.
_Avoid_: Prompt string, message options, unordered attachments

**Turn Handle**:
The caller's live control and event-consumption boundary returned by `AgentSession.startTurn`, exposing one Turn's ordered event stream, result, approvals, and interruption.
_Avoid_: Promise result, session subscription, event emitter

**Turn Result**:
The JSON-safe terminal value of an accepted Turn, discriminated as completed, failed, or interrupted and matching its final Turn Event.
_Avoid_: Promise rejection, prompt response, transcript

**Command Rejection**:
Failure to accept a requested Muha control operation, distinct from the terminal outcome of any active Turn.
_Avoid_: Turn Failure, Harness crash

**Turn Failure**:
The unsuccessful terminal outcome of an already accepted Turn.
_Avoid_: Command Rejection, thrown control error

**Turn Event**:
A public, Core-sequenced observation within one Turn, such as assistant output, tool activity, an Approval Request, usage, or the Turn's terminal state.
_Avoid_: Harness Event, Session event, Native event, log line, callback

**Native Event Record**:
A private diagnostic record of a decoded, semantically meaningful inbound protocol message or SDK callback/data result received from a Coding Harness before normalization, including relevant command responses and notifications but excluding outbound commands, transport metadata, credentials, framing, heartbeats, ready banners, and process logs.
_Avoid_: Turn Event, raw event API, compatibility escape hatch, process log

**Core Event Record**:
A private, compact diagnostic record written only when a public Turn Event is produced by Muha Core without a corresponding native protocol event, providing durable provenance without duplicating normalized copies of native-backed events.
_Avoid_: Native Event Record, public event replay, transcript, duplicate normalized event

**Diagnostic Event Store**:
The private SQLite store owned by one Muha Runtime, containing every complete Native Event Record and the Core Event Records required to back Core-originated public events.
_Avoid_: Public database API, event replay API, Session store, transcript store

**Capability**:
A closed, publicly named optional behavior that a Harness Adapter truthfully supplies without lossy emulation, and that Core can discover and enforce at its command or event boundary.
_Avoid_: Feature flag, Kernel behavior, dynamic health check, native-version promise

**Harness Capability Profile**:
The complete, JSON-safe, deeply frozen declaration of one official Harness Adapter's variable behavior, owned by its inactive Registration and stable for a Muha Runtime's lifetime, including after Runtime close.
_Avoid_: Live probe result, caller preference, mutable Harness state, Core lookup table

**Harness Compatibility**:
Portability of Muha's control interface and lifecycle guarantees across Coding Harnesses, without promising equivalent agent behavior or results for the same input.
_Avoid_: Behavioral equivalence, output parity, drop-in replacement

**Core Kernel**:
The non-optional minimum contract every official Harness Adapter must satisfy: Runtime and Session lifecycle, creation, resume by known reference, text Turns, stable Turn Handles, retry and interruption, exactly one terminal result, final Assistant Message delivery, structured failures, and empty Workspace configuration.
_Avoid_: Capability, all-Harness feature parity, optional event family

**Core Conformance**:
The three-layer verification contract comprising one mandatory Core Kernel suite, independently runnable Capability suites for each declared optional behavior, and a Declaration suite that validates Profile truthfulness and enforcement.
_Avoid_: One all-or-nothing feature checklist, best-effort adapter, startup probe

**Declaration Conformance**:
The Conformance layer that verifies a Harness Capability Profile is complete, immutable, stable, JSON-safe, and honest in both directions: claimed suites pass and absent callable behavior rejects without forbidden side effects.
_Avoid_: Native capability negotiation, documentation-only claim, smoke test

**Approval Request**:
A harness-originated request for a caller to allow one proposed agent action once or deny it, identified within its Turn until answered or invalidated.
_Avoid_: Confirmation message, prompt

**Approval Decision**:
The one-shot caller response to an Approval Request, either `allowOnce` or `deny`.
_Avoid_: Approval Policy, allow always, approve for Session, cancel

**Approval Policy**:
The Session-run selection that chooses the Harness's declared native autonomous execution mode and approves any remaining native Approval Requests once through `autoApprove`, surfaces native Approval Requests through `interactive`, denies those requests through `autoDeny`, or delegates permission decisions to native configuration through `harnessManaged`. Native autonomous execution accepts the Harness-specific permission and interaction behavior without promising equivalent authority across Harnesses; a native denial without an Approval Request cannot be approved, and Questions remain distinct.
_Avoid_: Symmetric allow/deny switch, universal full access, sandbox guarantee, persistent permission rule

**Question**:
A harness-originated, typed request for caller-provided choices, text, numbers, booleans, or acknowledgement of an external action during an active Turn, distinct from permission to perform an agent action. One Question Request contains ordered fields, each with its own identity, constraints, optional default and earlier-field conditions; Core validates an answer or whole-request dismissal while the native request remains pending. A hidden field is a presentation hint, and its default value stays private even though the caller can choose to use it.
_Avoid_: Approval Request, Assistant Message, prompt

**Grilling Focus**:
An optional caller-selected subject that prioritizes a Grilling Run's examination without excluding related risks or changing its completion or report contract.
_Avoid_: Grilling Topic, scoring dimension, report schema, completion criterion

**Grilling Turn Output**:
An ordered caller-delivered observation containing one Grilling Role's successful Turn final Assistant Message and its zero-based paired round.
_Avoid_: Transcript, Turn Event, log record, reasoning stream, Tool activity stream
