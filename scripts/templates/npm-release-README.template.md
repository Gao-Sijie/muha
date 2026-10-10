# Muha SDK npm candidate V{{VERSION}}

{{CANDIDATE_STATUS}}

This seven-package candidate contains @muha-sdk/muha, Core and the five official Adapters. Only
the tarballs listed in release.json may be published. They share one version;
each Adapter depends on that exact Core version. The root workspace is private.

Check the artifact before publishing:

```sh
sha256sum --check SHA256SUMS
```

release.json records the committed source, lockfile digest, tarball SHA256 and
SHA512 integrity, file lists, runtime resources and production dependency review.
Publication requires the separately reviewed public source and registry audit.
Use provenance from the controlled GitHub Actions workflow. Candidate packing
does not establish a successful registry installation or real-model qualification.

After all seven exact versions are published and accepted from a cold registry
install and lockfile npm ci, consumers can install the complete SDK:

```sh
npm install --save-exact @muha-sdk/muha@{{VERSION}}
```

See the [package-specific usage](https://github.com/Gao-Sijie/muha#readme) and
[qualification and limitations](https://github.com/Gao-Sijie/muha/blob/main/QUALIFICATION.md).
