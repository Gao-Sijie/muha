# Separate SDK development source from private orchestration

Accepted 2026-09-30 under user-approved repository cutover spec. `Gao-Sijie/muha`
becomes the sole SDK development source after private remote-clone and CI acceptance,
containing Core and five official Adapters; Orchestrator belongs to an independent
private project. Import an audited source snapshot, preserve target Git ancestors
and retain internal privately until both placements pass, avoiding a permanent export
pipeline that could overwrite later SDK contributions.

This distribution project supersedes ADR-0132's internal-only scope for future SDK
work, not its historical optimization/acceptance. ADR-0111 and ADR-0114 still describe
historical local artifact sets and do not constrain future separately approved npm
publication. During migration the six SDK packages remain `0.1.13`/`private:true`;
public visibility, Registry publication and consumer validation are separate gates.
Before npm publication a private Orchestrator may use a temporary adjacent workspace
pinned to an exact SDK revision; that is not Registry-install acceptance.
