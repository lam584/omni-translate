# Staged Driver Package

Run `npm run driver:build-sysvad` to stage the signed SYSVAD-derived package.

The package registers both `Omni Translate Virtual Speaker` and
`Omni Translate Virtual Microphone`. ABI `0x20260810` adds the bounded,
generation-scoped Bridge-to-driver PCM write route used by the capture endpoint.
The INF is decorated for Windows 10 build `19041` and newer.

The development package contains the public test certificate. The private PFX
and password remain under the ignored `artifacts/driver-signing` directory.
`driver-package.json` records the audited/import minimum Windows build and
whether the staged package is development-test or release-injected signed.
