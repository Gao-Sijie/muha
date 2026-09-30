# Require a core adapter conformance profile

A supported Harness Adapter must provide session creation, resumption and listing, text and image input, ordered Turn Events with one terminal state per Turn, interruption and closure, structured failures, MCP, and Skills. Muha V0.1 exposes no partial support or optional-capability discovery: an integration below Core Conformance is not a supported Adapter, and behavior outside the profile remains unavailable until Muha defines a future public Capability and contract tests for it.
