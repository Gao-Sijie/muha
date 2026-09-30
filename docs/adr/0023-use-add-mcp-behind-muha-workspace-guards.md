# Use add-mcp behind Muha Workspace guards

Muha will use a pinned `add-mcp` dependency internally to write supported Harnesses' project-level native MCP configuration. Muha retains ownership of validation and limits writes to the requested project-level server entries, replacing a conflicting same-name entry while preserving unrelated native configuration; it does not expose `add-mcp` types or its global, removal, or synchronization operations. Kimi project configuration remains a small Muha-owned target, with no requirement to contribute that target upstream.
