---
status: superseded by ADR-0026
---

# Require explicit adapter registration

Muha Runtime will accept explicitly constructed Harness Adapter instances and Core will not resolve vendor names into hidden package imports or installations. Vendor packages remain independently typed and versioned dependencies, allowing callers to register only what they use, supply fake or third-party adapters, and keep Core free of vendor SDK dependencies.
