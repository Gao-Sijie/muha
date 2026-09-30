# Accept AGY Native Turn Timeouts with an Adapter Warning

AGY 1.2.2 accepts a positive `--print-timeout 10m` and completed the qualified long Turn after 324.734 seconds, while `0` and `-1s` expire immediately instead of disabling the timeout. The user accepts this AGY limitation: the AGY Adapter may use a disclosed, positively qualified native ceiling and warn callers when activated; lack of an unlimited native setting alone no longer blocks admission. This is an AGY-specific exception to ADR-0108's unbounded execution expectation, adds no Core execution timer or public option, and does not change other Harnesses or Question waiting.

The warning must state the actual native limit without claiming that it is unlimited. A detected native timeout remains an explicit Turn failure through existing structured errors; partial native `SUCCESS` output must not silently become a completed Muha Turn, and research guards are not production execution deadlines.

On 2026-09-16 the user requested increasing the Adapter's native limit from `10m` to `60m` and repacking V0.1.12 at the same version. The current setting is `--print-timeout 60m`, with matching warning and failure messages. It bounds each Turn's total result wait; intermediate output does not reset the deadline. The earlier 324.734-second qualification remains historical evidence, not a claim that a full 60-minute run was tested.
