# Keep native events private in SQLite

Muha will not expose an `adapter.raw` event or other native-event escape hatch through its public API. Every native event will instead be captured as a private SQLite-backed Native Event Record for diagnostics, while only normalized Turn Events are delivered through the Turn Handle. ADR-0106 additionally persists compact Core Event Records for public events without a native source; V0.1 provides no interface for querying or replaying either private record kind.
