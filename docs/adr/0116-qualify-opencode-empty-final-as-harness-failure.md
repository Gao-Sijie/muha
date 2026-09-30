# Qualify OpenCode Empty Finals as Harness Failures

ADR-0076 remains the general rule that the last completed Assistant Message is a successful Turn's final message, but an OpenCode Turn that reaches idle with an empty or whitespace-only last completed message is a provider-specific invalid final. The OpenCode Adapter therefore emits a `HARNESS_ERROR` Turn Failure for `startTurn` with native code `empty_final_message` and no `retryable` hint; Core's existing Session retry policy decides whether to reattempt it, while non-empty finals, intermediate empty messages, and other adapters retain their existing semantics.

This qualification is intentionally confined to the OpenCode Adapter: it avoids a Core-wide empty-message rule, adds no health check, and leaves the Orchestrator's `EMPTY_AGENT_MESSAGE` fallback as the final safety net.
