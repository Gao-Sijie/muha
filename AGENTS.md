# Muha SDK agent instructions

This repository contains the `@muha-sdk/muha` SDK entry package, Core and five official Harness Adapters.

- Before changing behavior, read [CONTEXT.md](CONTEXT.md) and
  [qualification and exceptions](QUALIFICATION.md). When local `docs/adr/` is
  available, read the relevant decisions and preserve their historical scope.
- Keep plans, ADRs and private evidence in ignored `docs/` or `.scratch/` paths.
  Preserve local documents when removing Git tracking. New commits must contain
  no `docs/` directory at any depth; never force-add ignored documents.
- For SDK issues, always use `gh --repo Gao-Sijie/muha`; read the originating
  specification and comments before implementation, or use the approved local
  plan when no originating issue exists. Close only completed tickets and keep
  sanitized command receipts in ignored paths.
- Run the affected controlled contracts, typecheck and full `npm run check` before handoff.
  `npm run check:repository` checks the Git index; CI also checks the committed
  tree. [Qualification](QUALIFICATION.md) distinguishes preserved real evidence
  from migration tests. Real models require explicit authorization.
- Write new specs under the ignored local `docs/proposal/` directory.

Orchestrator development belongs in its separate private project. Public visibility,
npm publication and consumer application validation are independently approved work.
