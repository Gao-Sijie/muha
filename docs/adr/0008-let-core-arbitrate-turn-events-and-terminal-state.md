# Let Core arbitrate Turn events and terminal state

Muha Core will assign canonical Turn IDs and event sequence numbers, validate adapter-translated state transitions, and emit exactly one terminal event as the final public event of each Turn. Harness Adapters supply native facts and identifiers; invalid transitions fail the Turn with an adapter protocol error, while native events arriving after the terminal boundary are confined to diagnostics, including raw events.
