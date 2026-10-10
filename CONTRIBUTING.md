# Contributing

Use [Gao-Sijie/muha Issues](https://github.com/Gao-Sijie/muha/issues) for SDK work.
Read [CONTEXT.md](CONTEXT.md) and [qualification and exceptions](QUALIFICATION.md)
before changing behavior; the public API, static Profiles and native behavior
are contractual. Consult relevant local `docs/adr/` decisions when available.

## Develop

Requires Node.js >=22.20.0 on Linux x64 glibc, a C compiler and `readelf`.
Consumers install prebuilt Muha packages from npm; these commands are for contributors.
CI uses Ubuntu 22.04 as its qualified compiler host and enforces glibc 2.28 as
the native helper ABI floor.

```sh
npm ci
npm run clean
npm run build
npm run typecheck
npm run check
```

Use controlled fixtures at
Harness/provider process boundaries; verify public Runtime/Session/Turn behavior
and isolated package installation, rather than adding a public testing interface.
Run the affected test first and full `npm run check` before handoff. Preserve
resource/permission, ESM, declarations, ordinary dependency and cleanup guarantees.

This repository is the sole development source for the `muha` entry package,
Core and five official Adapters; Orchestrator belongs in its separate private project.
The seven SDK packages share one release version and public npm metadata; the root
workspace remains `private:true`. Publishing requires a clean, verified source
candidate and the controlled release workflow. Do not add Orchestrator workspaces or
copy private diagnostics into this SDK. Real models require explicit approval;
unchanged source can retain [qualified evidence and limitations](QUALIFICATION.md).

Plans, historical ADRs and private evidence stay in ignored local `docs/` and
`.scratch/` paths. Preserve local documents when removing their Git tracking.
New commits contain no `docs/` directory at any depth. Run
`npm run check:repository` before committing; CI checks the committed tree too.

See [RELEASING.md](RELEASING.md) for reviewed candidates, npm publication and
public Registry consumer acceptance.
