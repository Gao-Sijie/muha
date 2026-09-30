# Require explicit Runtime close

The caller owns process lifecycle and must release a Muha Runtime through its idempotent asynchronous `close()` method, normally from `finally`; Muha installs no `SIGINT`, `SIGTERM`, `beforeExit`, global-exception, or rejection handlers, never calls `process.exit()`, and does not rely on garbage collection for asynchronous cleanup. Once closing begins the Runtime accepts no new commands, and host applications, CLIs, services, and test runners remain responsible for choosing when to call `close()` and what exit status or signal behavior follows.
