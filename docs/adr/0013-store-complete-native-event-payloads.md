# Store complete Native Event Record payloads

Native Event Records retain every complete decoded inbound semantic vendor payload without redaction, deliberately prioritizing diagnostic fidelity over data minimization. ADR-0107 clarifies that “complete” does not expand the record into outbound commands, credentials, transport headers, framing, heartbeats, ready banners, or process logs. The Diagnostic Event Store must therefore still be treated as sensitive workspace data with explicit access, location, retention, and durability policies; choosing SQLite rather than a text format does not provide encryption.

ADR-0139 adds a narrow exception for OpenCode v2 Form events: hidden defaults, dependent comparisons, reply answers, and arbitrary Form metadata are redacted before diagnostic storage. The live native event remains available privately to the Adapter for the pending interaction.
