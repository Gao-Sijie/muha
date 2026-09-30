# Declare and enforce static Harness Capabilities

[ADR-0119](0119-select-native-autonomous-execution-through-auto-approve.md)
supersedes the V0.1.11 expectation of unchanged `autoApprove` permissions and
event occurrence. The Profile shape and static declaration/enforcement model
remain unchanged; `turnQuestions` still describes the independent lifecycle.

Muha V0.1.11 replaces the all-or-nothing Adapter profile from ADR-0003 and the absence of discovery from ADR-0036 with a mandatory Core Kernel plus closed optional Capabilities. Each official Harness Registration owns one complete, JSON-safe Capability Profile that Core validates, snapshots, deeply freezes, and exposes synchronously through `MuhaRuntime.getHarnessCapabilities()` without probing the live Harness. Core remains the enforcement authority: unsupported commands reject before native action with `UNSUPPORTED_CAPABILITY`, unsupported Workspace pairs become direct failed attempts, and Adapter events that contradict the declaration fail the accepted Turn with `ADAPTER_PROTOCOL_ERROR`. `harnessManaged` is an exact Approval Policy that delegates permission decisions without public Approval events. Conformance is correspondingly layered into Kernel, independently runnable Capability suites, and Declaration checks. Codex, OpenCode, and Kimi Code declare their existing behavior; AGY and Pi receive no normative Profile and remain outside V0.1.11. Historical ADR-0003 and ADR-0036 remain in the repository as superseded decisions.
