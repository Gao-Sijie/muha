# Expose Grilling Turn Output Through a Caller Callback

Muha Orchestrator exposes each successful Grilling Role final Assistant Message through one optional, serially awaited caller callback using zero-based paired rounds, while retained JSONL remains metadata-only. Callback delivery can apply backpressure and fails the Grilling Run without being mistaken for a Harness Turn failure; Orchestrator does not accumulate a Transcript, expose general Muha Turn Events, or own the caller's output destination.
