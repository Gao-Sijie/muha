# Expose read-only Runtime and Session state

Muha Runtime exposes a synchronous JSON-safe state snapshot discriminated as `active`, `closing`, or `closed`, while Agent Session exposes a snapshot discriminated as `idle`, `running` with the active Turn ID, or `closed`. The snapshots provide no subscription or lifecycle event, never include a recoverable failed state, and do not replace Core's atomic state check when a command is accepted; a completed Turn returns its Session to idle, and any closed Runtime or Session remains closed even when its cleanup reported an error.
