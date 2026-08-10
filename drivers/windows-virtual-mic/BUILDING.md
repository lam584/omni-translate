# Omni Virtual Audio Driver

This directory vendors a SYSVAD-derived pair of WaveRT endpoints:

- render: `Omni Translate Virtual Speaker`
- capture: `Omni Translate Virtual Microphone`

The driver captures the pre-mix PCM rendered by applications and exposes it to
the native Bridge through `\\.\OmniTranslateVirtualAudio`. The Bridge reads the
PCM with `IOCTL_OMNI_BRIDGE_READ_PCM`, sends only that source stream to the
desktop process, mixes translated PCM in user mode, and plays the result to the
selected physical speaker.

For outbound virtual-microphone output, Bridge owns one generation-scoped
session on the same control device. It submits canonical `48 kHz`, mono,
PCM16 samples through `BEGIN_MIC_SESSION`, `WRITE_MIC_PCM`, and
`END_MIC_SESSION`; applications capture those samples from the virtual
microphone endpoint at the WaveRT hardware clock. The write ring is bounded to
five seconds and evicts the oldest samples on overflow. Capture underruns are
zero-filled. Session ownership is bound to the opening file handle so a crashed
Bridge automatically ends the active session, while already-buffered final
samples remain available to drain.

## Prerequisites

- Visual Studio 2022 Community with MSVC v143.
- Windows SDK and WDK `10.0.26100.6584`.
- Windows 10 build `19041` or newer on the install/runtime machine.
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

Before packaging, `dumpbin /imports` checks every imported kernel symbol against
`tests/fixtures/kernel-import-minimum-builds.json`. Unknown imports fail the
build until their OS availability is audited. The current limiting import is
`ntoskrnl!ExAllocatePool2`, introduced in build `19041`; the INF and installer
therefore use the same minimum. This gate prevents a newer WDK API from silently
raising the runtime requirement.

## Install On A Test Machine

Enable test signing once from an elevated PowerShell session, restart Windows,
then install:

```powershell
.\scripts\installer\enable-test-signing.ps1
npm run driver:install
```

The development installer trusts the staged certificate, stages the package,
creates `Root\OmniTranslateVirtualSpeaker` with WDK `devcon`, waits for both
AudioEndpoint interfaces, verifies ABI `0x20260810`, and writes
`driver-install-state.json` with both endpoint identities and the outbound
virtual-microphone capability.

Run the endpoint and IOCTL probe again at any time:

```powershell
npm run driver:test
```

The probe exercises both directions. Its `virtualMic` result writes a paced
1 kHz fingerprint through the driver ABI, captures it from
`Omni Translate Virtual Microphone`, and verifies the observed frequency plus
the kernel written/consumed/drop/reject/session counters.

The same command then runs the production-route acceptance probe. It starts an
isolated v6 Bridge, launches `omni-virtual-mic-target-capture.exe` as a separate
WASAPI target process, sends one uniquely fingerprinted
`virtual-mic`/`outbound` cue through the Bridge audio pipe, and writes:

- `virtual-mic-capture.wav`
- `virtual-mic-capture-probe.json`
- `runtime-snapshot.json`

under a new timestamped `artifacts/testing/manual-e2e/virtual-mic-capture-*`
directory. Missing endpoints, a capability other than `supported + ready`, an
audio NACK, missing or duplicate cue lifecycle events, a fingerprint mismatch,
or any physical-playback frame delta fails the command; there is no skip path.
Use a specific empty output directory when collecting a release receipt:

```powershell
npm run driver:test -- --VirtualMicEvidenceOutputDirectory `
  .\artifacts\manual-source\virtual-mic-capture
node .\scripts\testing\archive-release-manual-evidence.mjs `
  --scenario-id E2E-VIRTUAL-MIC-CAPTURE `
  --source .\artifacts\manual-source\virtual-mic-capture
```

The target-capture binary refuses to overwrite an existing evidence file. It
does not install, repair, trust, or elevate the driver; installation remains a
separate explicit step.

The non-elevated boundary and portable ring tests are:

```powershell
npm run test:driver-boundaries
cd drivers\windows-virtual-mic\tests
cl /std:c++17 /EHsc /I..\include omni_ring_core_test.cpp
.\omni_ring_core_test.exe
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
