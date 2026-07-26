# Windows Virtual Audio Tests

Driver validation should cover install state creation, bridge frame writes, and
endpoint isolation from the default WASAPI loopback device.

## User-mode boundary tests

Minimal user-mode tests cover the omni-owned driver boundaries only. Vendored
sysvad sources under `../sysvad` are exempt and are never imported or tested
here. The tests run on any development machine without the development driver
installed; the ioctl contract is simulated in user mode.

| Declared boundary | Test file |
| --- | --- |
| Install state creation | `install-state.test.mjs` |
| Bridge frame writes (`include/omni_bridge_ioctl.h`) | `bridge-frame-writes.test.mjs` |
| Endpoint isolation from the default WASAPI loopback device | `endpoint-isolation.test.mjs` |

Run all three from the repository root:

```powershell
npm run test:driver-boundaries
```

## Shared fixtures

`fixtures/` holds the contract fixtures shared with the integration test plan
(`scripts/installer/probe-development-driver.ps1` and
`scripts/testing/prepare-install-regression-report.mjs` validate the same
contracts against a real installation):

- `driver-install-state.sample.json` — the exact shape written by
  `scripts/installer/install-development-driver.ps1`.
- `bridge-ioctl-contract.json` — device names, CTL_CODE values, ABI version,
  `OMNI_BRIDGE_STATUS` layout, and PCM frame geometry.
- `render-endpoints.sample.json` — a WASAPI render endpoint list containing the
  virtual speaker and physical devices for isolation checks.

`driver-boundary-helpers.mjs` contains the user-mode contract simulations
(CTL_CODE derivation, install-state health classification, endpoint selection,
and the bridge ring counter model) reused across the tests.
