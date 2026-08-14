# Staged Driver Package

Run `npm run driver:build-sysvad` to stage the signed SYSVAD-derived package.

The package registers both `Omni Translate Virtual Speaker` and
`Omni Translate Virtual Microphone`. ABI `0x20260810` adds the bounded,
generation-scoped Bridge-to-driver PCM write route used by the capture endpoint.
The INF is decorated for Windows 10 build `19041` and newer.

The development package contains the public test certificate. The private PFX
and password remain under the ignored `artifacts/driver-signing` directory.
`../src/driver_package_contract.json` is the tracked source contract for the
protocol, platform, and audited/import minimum Windows build. The build writes
the ignored `driver-package.json` runtime receipt next to the staged binaries. That receipt
records the actual signer and whether the package is development-test or
release-injected signed; installer and release evidence must consume the receipt,
not the template.
