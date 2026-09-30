# Use SQLite Exclusively for Diagnostic Event Records

Muha will store Diagnostic Event Records in SQLite at runtime and will not maintain a parallel JSONL representation for tests, fixtures, or export in the initial design. A single internal store retains the complete vendor payload of every Native Event Record as JSON text and, as added by ADR-0106, compact Core Event Records only where no native event can back a public event, keeping ordering, integrity, and future diagnostics in one private format.
