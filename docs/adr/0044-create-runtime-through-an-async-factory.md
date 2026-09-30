# Create Runtime through an async factory

Muha exposes `MuhaRuntime` as a public type with no public constructor or separate initialization method and creates it only through `await createMuhaRuntime(config)`. The factory validates the host, acquires process and data-directory guards, opens the Diagnostic Event Store, initializes every configured Harness Adapter, and waits for native readiness before returning; any failure performs all-or-nothing rollback and rejects without exposing a partially initialized Runtime, so every method on a returned Runtime is immediately usable.
