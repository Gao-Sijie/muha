# Security

Do not post credentials, native conversations, Diagnostic Event Stores, process
logs or private Orchestrator resources in public issues, CI logs or artifacts.
For suspected vulnerabilities, use GitHub private vulnerability reporting when
available; otherwise ask the repository owner for a private reporting channel
without including sensitive details. The migration does not configure that channel.

Muha drives authenticated local Harnesses and can execute their tools. Approval
Policies do not create a security sandbox; use only trusted Workspaces, Skills,
MCP configuration and native extensions. Pi patched SDK workers preserve native
behavior and do not sandbox extensions. Diagnostic records may contain complete
unredacted native data; retention and capacity are caller-managed.

Before public visibility changes, independently audit all reachable history,
Actions logs/artifacts, licenses and governance. Before npm publication, separately
check scope permissions, package allowlists, version/configuration and independent
Registry installs. A private clone test is not either authorization.
