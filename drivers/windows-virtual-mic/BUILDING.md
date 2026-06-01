# Omni Virtual Speaker Driver

This directory vendors a SYSVAD-derived WaveRT render endpoint named
`Omni Translate Virtual Speaker`.

The driver captures the pre-mix PCM rendered by applications and exposes it to
the native Bridge through `\\.\OmniTranslateVirtualAudio`. The Bridge reads the
PCM with `IOCTL_OMNI_BRIDGE_READ_PCM`, sends only that source stream to the
desktop process, mixes translated PCM in user mode, and plays the result to the
selected physical speaker.

## Prerequisites

- Visual Studio 2022 Community with MSVC v143.
- Windows SDK and WDK `10.0.26100.6584`.
- An elevated PowerShell session for certificate trust and driver install.
- A dedicated Windows test machine with `TESTSIGNING` enabled for development
  packages.

## Build A Development Package

Run:

```powershell
npm run driver:build-sysvad
```

The script creates an ignored MSBuild overlay under `artifacts/driver-build`,
builds the x64 SYSVAD endpoint, validates the INF with `InfVerif /u`, generates
a development signing credential when needed, signs the SYS and CAT, and stages:

- `package/omni-virtual-speaker.inf`
- `package/omni-virtual-speaker.sys`
- `package/omni-virtual-speaker.cat`
- `package/omni-translate-development-driver.cer`

The generated PFX and password stay under
`artifacts/driver-signing/development`. Never commit or distribute them.

## Install On A Test Machine

Enable test signing once from an elevated PowerShell session, restart Windows,
then install:

```powershell
.\scripts\installer\enable-test-signing.ps1
npm run driver:install
```

The development installer trusts the staged certificate, stages the package,
creates `Root\OmniTranslateVirtualSpeaker` with WDK `devcon`, waits for the
`AudioEndpoint`, verifies the driver IOCTL ABI, and writes
`driver-install-state.json`.

Run the endpoint and IOCTL probe again at any time:

```powershell
npm run driver:test
```

## Release Signing

Release signing credentials remain external to the repository. Inject them
without copying them into the workspace:

```powershell
.\scripts\installer\build-sysvad-driver.ps1 `
  -Configuration Release `
  -SigningPfxPath C:\secure\release-driver.pfx `
  -SigningPfxPasswordPath C:\secure\release-driver-password.txt
```

Production deployment must use the organization release-signing process and
must not enable `TESTSIGNING`. `npm run installer:prepare` rejects packages
that still contain the development certificate and copies only the staged
INF/SYS/CAT files into the stable installer layout.

## Upstream

The vendored sample is derived from Microsoft Windows Driver Samples SYSVAD.
See `sysvad/UPSTREAM-COMMIT.txt` and `sysvad/UPSTREAM-LICENSE.txt`.
