# Muha SDK agent instructions

This repository contains Core and five official Harness Adapters only.

- SDK issues/specs use `gh --repo Gao-Sijie/muha`; read [tracker conventions](docs/agents/issue-tracker.md).
- Before changing behavior, read [CONTEXT.md](CONTEXT.md), [domain navigation](docs/agents/domain.md)
  and the relevant [ADRs](docs/adr/README.md).
- Run the affected controlled contracts, typecheck and full `npm run check` before handoff.
  [Qualification](docs/testing/sdk-qualification.md) distinguishes preserved real evidence
  from migration tests. Real models require explicit authorization.
- Write new specs under `docs/proposal/`.

Orchestrator development belongs in its separate private project. Public visibility,
npm publication and consumer application validation are independently approved work.
