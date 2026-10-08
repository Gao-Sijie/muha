# Contributing

Use [Gao-Sijie/muha Issues](https://github.com/Gao-Sijie/muha/issues) for SDK work.
Read [CONTEXT.md](CONTEXT.md) and [qualification and exceptions](QUALIFICATION.md)
before changing behavior; the public API, static Profiles and native behavior
are contractual. Consult relevant local `docs/adr/` decisions when available.

Follow the [development commands](README.md#develop). Use controlled fixtures at
Harness/provider process boundaries; verify public Runtime/Session/Turn behavior
and isolated package installation, rather than adding a public testing interface.
Run the affected test first and full `npm run check` before handoff. Preserve
resource/permission, ESM, declarations, ordinary dependency and cleanup guarantees.

This repository is the sole development source for Core and five official
Adapters; Orchestrator belongs in its separate private project. The six SDK packages share release version `0.1.13` and public npm metadata; the root workspace remains `private:true`. Publishing requires a clean, verified source candidate and the controlled release workflow. Do not add Orchestrator workspaces or
copy private diagnostics into this SDK. Real models require explicit approval;
unchanged source can retain [qualified evidence and limitations](QUALIFICATION.md).

Plans, historical ADRs and private evidence stay in ignored local `docs/` and
`.scratch/` paths. Preserve local documents when removing their Git tracking.
New commits contain no `docs/` directory at any depth. Run
`npm run check:repository` before committing; CI checks the committed tree too.
