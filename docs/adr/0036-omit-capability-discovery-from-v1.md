# Omit Capability discovery from V0.1

Muha V0.1 exposes no `CapabilityName`, capability-discovery method, or `UNSUPPORTED_CAPABILITY` error because every supported official Adapter must satisfy Core Conformance and behavior outside that profile has no public call surface. Invalid caller data produces `INVALID_INPUT`, Harness- or model-specific rejection produces `HARNESS_ERROR`, and a future optional Capability must introduce its name, strong public type, failure semantics, and contract tests together rather than occupying an unreachable V0.1 placeholder.
