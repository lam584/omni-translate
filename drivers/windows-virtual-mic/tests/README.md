# Windows Virtual Audio Tests

Driver validation covers three distinct signal layers:

| Signal | Toolchain | Privileges | What it proves |
| --- | --- | --- | --- |
| User-mode Node contract tests | Node.js (`node --test`) | None | IOCTL ABI shape, install-state health, endpoint isolation |
| Native C++ smoke tests | MSVC `cl.exe` / `clang++` (no WDK) | None | Ring buffer state transitions, overwrite semantics, counters |
| WDK mechanical build | EWDK / WDK 10.0.26100 | None (build only) | Driver binary compiles without errors |

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

## Native C++ smoke tests

The Omni ring buffer core (`include/omni_ring_core.h`) is a portable extraction
of the production ring logic in `sysvad/omni_bridge_ring.cpp`. It compiles with
any standard C++17 toolchain — no WDK, no kernel headers, no administrator.

| Coverage area | Test file |
| --- | --- |
| Empty read, reset, write/read order, wrap-around | `omni_ring_core_test.cpp` |
| Overwrite-oldest semantics, counter correctness | `omni_ring_core_test.cpp` |
| Loopback/bridge ring state isolation | `omni_ring_core_test.cpp` |

Build and run:

```powershell
cd drivers/windows-virtual-mic/tests
cl /std:c++17 /EHsc /I..\include omni_ring_core_test.cpp /Fe:omni_ring_core_test.exe
.\omni_ring_core_test.exe
```

## Coverage scope registry

The driver layer is registered in `scripts/testing/coverage-scope-registry.json`:

- **Vendored SYSVAD** (`sysvad/**`): `exempt` — upstream Microsoft sample.
- **Omni production units** (`omni_bridge_ring.*`, `omni_ring_core.h`, `omni_bridge_ioctl.h`): `native-smoke-required`.
- New non-vendored C/C++ files MUST be registered before merge; missing test targets fail the gate.

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
