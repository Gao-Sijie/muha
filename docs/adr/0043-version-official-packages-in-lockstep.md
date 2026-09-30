---
status: superseded by ADR-0111
---

# Version official packages in lockstep

Every Muha V0.1 Release assigns the same SemVer version to `@muha-sdk/core` and all three official `@muha-sdk/*-adapter` packages and publishes the complete official package set even when a package's contents did not change. Official Adapters require the exactly matching Core version so their implementation protocol cannot drift within an official installation; consumers may install only the Adapters they use but keep every installed official package on one Muha Release.
