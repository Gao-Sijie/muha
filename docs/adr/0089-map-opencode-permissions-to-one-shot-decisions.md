# Map OpenCode Permissions to One-Shot Decisions

[ADR-0119](0119-select-native-autonomous-execution-through-auto-approve.md)
extends `autoApprove` to the active Session tree, following native `run --auto`
semantics. The one-shot mapping and preservation of explicit native deny below
remain in force; no Session-wide allow rule is installed.

The OpenCode Adapter maps Muha `allowOnce` to the native permission reply `"once"` and Muha `deny` to `"reject"`, for both caller responses and automatic Approval Policy responses, and never sends OpenCode's persistent `"always"` reply. It does not replace, merge, or bypass OpenCode permission rules found through the Workspace or native user configuration: Approval Policy acts only after OpenCode originates a permission request. Consequently a native rule that allows or denies an operation without asking produces no synthetic Muha Approval Event, and Muha does not claim to normalize which operations require approval.
