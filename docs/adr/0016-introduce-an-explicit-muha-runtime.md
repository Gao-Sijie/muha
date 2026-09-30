---
status: superseded by ADR-0019
---

# Introduce an explicit Muha Runtime

Callers will create a Muha Runtime as the root lifecycle object that owns the shared Diagnostic Event Store, writer, global buffer budget, adapter instances, and shutdown order. The SDK will not use a hidden process singleton; multiple runtimes are allowed only with distinct data directories, keeping higher-level orchestration outside the Runtime while making shared resource ownership explicit.
