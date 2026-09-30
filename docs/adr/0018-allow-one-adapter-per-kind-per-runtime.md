---
status: superseded by ADR-0026
---

# Allow one adapter per kind per Runtime

Each Muha Runtime will accept at most one Harness Adapter instance for a given Adapter Kind, rejecting duplicate kinds and reuse of the same adapter object across runtimes. Parallel work, multiple working contexts, and any vendor-specific process sharing are represented through Agent Sessions or kept private to the adapter rather than modeled as multiple public adapter instances.
