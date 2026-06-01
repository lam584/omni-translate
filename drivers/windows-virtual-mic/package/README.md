# Staged Driver Package

Run `npm run driver:build-sysvad` to stage the signed SYSVAD-derived package.

The development package contains the public test certificate. The private PFX
and password remain under the ignored `artifacts/driver-signing` directory.
`driver-package.json` records whether the staged package is development-test or
release-injected signed.
