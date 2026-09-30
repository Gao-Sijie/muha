# Limit AGY Descendant Cleanup to a Live Supervisor

The user excludes simultaneous loss of AGY's dedicated cleanup supervisor from the first AGY Adapter's descendant-cleanup guarantee. With that supervisor alive, normal Session/Runtime closure, interruption, AGY exit or SIGKILL, and permanent control loss must still stop and reap all owned descendants, including detached processes and late forks, without affecting unrelated processes or the consumer's process lifecycle.

Supervisor loss still causes an explicit failure and the established irreversible Runtime closure under ADR-0097; the Adapter does not claim successful descendant cleanup or transparently restart it. Reclaiming descendants after the supervisor itself has died is outside this release's acceptance scope, so namespace/systemd mechanisms are no longer required merely to cover that case; this does not automatically adopt a new runtime dependency or weaken other Harnesses.
