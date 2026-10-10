# Muha SDK diagnostic packages V{{VERSION}}

{{CANDIDATE_STATUS}}

This seven-package diagnostic set tests package-specific usage, files and licenses.
It is not a Muha Release, consumer delivery, npm Registry acceptance or publication.

Verify with `sha256sum --check SHA256SUMS`.
The isolated test uses temporary `npm install` fixtures; source development uses `npm ci`.
The installable packages are {{CORE_FILENAME}}, {{CODEX_FILENAME}}, {{OPENCODE_FILENAME}},
{{KIMI_FILENAME}}, {{PI_FILENAME}}, {{AGY_FILENAME}} and {{MUHA_FILENAME}}.
