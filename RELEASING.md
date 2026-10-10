# SDK releases

The release consists of `@muha-sdk/muha`, Core and all five official adapters, using one
version and exact internal dependencies. The root workspace remains private.
Release consumers may install `@muha-sdk/muha` alone or select individual adapter packages.

1. Update all seven package versions and internal dependency pins together.
   Preserve external dependency locks unless their change is part of the approved scope.
2. Run the affected contracts, `npm run check`, `npm run audit:packages` and
   `node scripts/verify-sdk-source.mjs`. Changed qualified runtime resources
   require separately authorized bounded real-model qualification.
3. Push reviewed source and dispatch [sdk-release](.github/workflows/sdk-release.yml)
   with `action=prepare` and its full main commit SHA. This runs controlled checks
   on Ubuntu 22.04 / Node 22.20.0, checks dependency/license closure and produces
   seven tarballs plus `README.md`, `SHA256SUMS` and `release.json`.
4. Review that artifact and its manifest SHA256. Dispatch `action=publish` with
   the same source SHA, successful preparation run ID and manifest SHA256.
   Publication downloads the original artifacts, without rebuilding them.
5. Core publishes first, adapters follow, and `@muha-sdk/muha` publishes last, with npm
   provenance and the `candidate` tag. Existing immutable versions must match
   the reviewed archive and provenance before the workflow can resume.
6. Anonymous public Registry consumers on Node 22.20.0 and LTS install Core,
   each adapter pair, all adapters, and `@muha-sdk/muha` alone. Their byte integrity,
   native resources, ESM/TypeScript and lifecycle contracts, dependency trees,
   and lockfile `npm ci` must pass before the explicit `latest` promotion job.
7. Read back all seven versions and `latest` tags, then create the source tag
   and public GitHub Release using the reviewed artifacts and registry receipt.

Registry propagation is handled through read-only verification, bounded by
60 attempts and five minutes per operation. Identity, byte or provenance
mismatches stop immediately. Failed npm uploads are not
automatically retried. Diagnose the Registry state before resuming a failed run.
On initial publication npm may assign `latest` even when a different upload tag
is requested; the explicit promotion job still follows consumer acceptance.

Publishing currently uses the short-lived `NPM_PUBLISH_TOKEN` Actions secret
with publish rights and 2FA bypass. Rights must cover all seven packages in the
`@muha-sdk` scope; organization management alone does not grant publish rights.
Trusted publishing can be configured in an actual future
release window; local npm login does not establish CI authentication.

Current Git trees and published packages contain no `docs/` directories.
Plans, raw diagnostics and publication receipts stay in ignored `docs/` or
`.scratch/` paths. Historical Git objects may contain documentation.
