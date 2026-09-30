# Contributing

Use [Gao-Sijie/muha Issues](https://github.com/Gao-Sijie/muha/issues) for SDK work.
Read [CONTEXT.md](CONTEXT.md) and [relevant ADRs](docs/adr/README.md) before changing
behavior; the public API, static Profiles and native behavior are contractual.

Follow the [development commands](README.md#develop). Use controlled fixtures at
Harness/provider process boundaries; verify public Runtime/Session/Turn behavior
and isolated package installation, rather than adding a public testing interface.
Run the affected test first and full `npm run check` before handoff. Preserve
resource/permission, ESM, declarations, ordinary dependency and cleanup guarantees.

The [migration decision](docs/adr/0141-separate-sdk-development-source-from-private-orchestration.md)
governs repository boundaries. All packages remain at `0.1.13` and `private:true`
until a separately approved npm release. Do not add Orchestrator workspaces or
copy private diagnostics into this SDK. Real models require explicit approval;
unchanged source can retain [qualified evidence and limitations](docs/testing/sdk-qualification.md).
