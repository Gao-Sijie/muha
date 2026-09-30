# Deliver V0.1 as a Local Artifact Set

> Superseded in part by ADR-0112: the single-`0.1.0` release description now covers only the original V0.1 artifact set; follow-up patch releases such as `0.1.1` are allowed within the same local delivery model.

Muha V0.1 remains one lockstep `0.1.0` release of Core and the Codex, OpenCode, and Kimi Adapters, but its release deliverable is four checksummed local npm tarballs plus machine-readable release metadata rather than npm Registry or GitHub Release publication. All four manifests are private to make accidental public publication fail closed; consumers install the Core tarball and only the Adapter tarballs they need, while ordinary third-party dependencies continue to resolve through the consumer's configured npm source. This supersedes ADR-0043 and ADR-0104 while preserving their complete-scope, exact-version, and no-staggering decisions.
