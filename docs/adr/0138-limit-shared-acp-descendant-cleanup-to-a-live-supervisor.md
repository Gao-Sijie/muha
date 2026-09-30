# Limit shared ACP descendant cleanup to a live supervisor

Status: accepted by the user on 2026-09-21 (option B); implementation and acceptance evidence remain separate.

The shared ACP transport's dedicated cleanup supervisor may itself die while native descendants remain alive. The user excludes complete descendant reclamation after that supervisor's own death from this release's guarantee, accepting possible surviving tools rather than adding kernel-isolation or privileged-environment prerequisites solely for this case. This is an explicit shared-ACP exception to the reclamation scope of ADR-0038/0046, not an inferred extension of AGY's ADR-0128 or a waiver for other native routes.

With the supervisor alive, all existing reclamation obligations remain, including normal closure, initialization rollback, native Harness exit or SIGKILL, permanent control loss, SIGTERM-resistant descendants, detached descendants and late forks; unrelated processes must remain untouched. Supervisor death must promptly report failure without waiting for descendant-held pipes, release Muha's own handles and waiters, and follow the existing all-or-nothing initialization or irreversible whole-Runtime fatal-close contract of ADR-0097; unproved cleanup must not be reported as success, and neither transparent restart nor cross-route replay is allowed.

Muha killing its own supervisor after a cleanup timeout does not excuse the preceding reclamation failure while that supervisor was alive. Tests and handoff records must distinguish successful cleanup from correct failure handling under this exception; the decision neither accepts an existing candidate nor waives any unrelated requirement. See the [boundary design (historical private reference)](../testing/private-history.md).
