# Omni SYSVAD-Derived Driver Sources

This directory contains the Microsoft SYSVAD code retained by Omni Translate
and the project-specific virtual-speaker bridge. It is intentionally not a
complete copy of the Windows Driver Samples SYSVAD solution.

## Upstream and license

The retained Microsoft sources are derived from
`microsoft/Windows-driver-samples` commit
`90c9d7a3806698e5716170efe264fd3d637816e5`. See `UPSTREAM-COMMIT.txt` for the
recorded revision and `UPSTREAM-LICENSE.txt` for the Microsoft Public License.

GitHub Linguist treats this directory as vendored code through the repository
`.gitattributes` file.

## Retained components

- `EndpointsCommon/` provides the WaveRT and speaker-topology implementation.
- `TabletAudioSample/` contains the x64 kernel-driver project and the single
  componentized INF used for the Omni virtual speaker.
- `adapter.cpp`, `common.cpp`, and their supporting files provide the PortCls
  adapter implementation.
- `omni_bridge_ring.cpp` and `omni_bridge_ring.h` expose rendered PCM to the
  native bridge through the Omni driver IOCTL ABI.

The upstream APO, keyword-detector adapter, package project, solution, and
unused sample INF inputs are deliberately omitted. They are not part of the
Omni build or install path.

## Build

Do not build this directory as the original Microsoft sample solution. Use the
repository build entry point so the WDK overlay, INF validation, import checks,
signing, and package staging are applied consistently:

```powershell
npm run driver:build-sysvad
```

See `../BUILDING.md` for prerequisites, development installation, verification,
and release-signing instructions.
