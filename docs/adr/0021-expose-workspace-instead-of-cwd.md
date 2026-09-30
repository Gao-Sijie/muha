---
status: superseded by ADR-0027
---

# Expose Workspace instead of cwd

Muha's public API will expose Workspace as a caller-constructible, JSON-safe absolute-path value and bind each Agent Session to its normalized path immutably for the Session lifetime. The Workspace is also the ownership and discovery boundary for project-scoped Skills and MCP configuration, while adapters privately map its path to vendor project and subprocess working-directory settings. `createSession` accepts an existing valid Workspace without requiring provenance from `initializeWorkspace`, but never creates its directory or configures it implicitly. Muha does not expose a separate `cwd`, infer a Git repository, register or own Workspace instances, delete a Workspace, or treat the Workspace as a sandbox boundary.
