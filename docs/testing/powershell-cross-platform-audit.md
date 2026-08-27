# PowerShell cross-platform orchestration audit

Audit date: 2026-08-28. The audit was performed before implementation against a clean worktree.

## Baseline and implemented boundary

| Area | Original PowerShell LOC | Responsibility found | Implemented boundary |
| --- | ---: | --- | --- |
| Startup IPC stress | 262 | plan handoff, launch/poll/timeout, log delta, evidence JSON, report handoff, process cleanup | Node now owns all orchestration and artifacts; the PowerShell file is an argument-compatibility wrapper |
| Startup readiness runner | 346 | Vite lifecycle/warmup, Tauri lifecycle, Windows window discovery, log polling, collection dispatch | Retained for this change: its window discovery and dev-shell lifecycle are coupled to the existing Windows startup modules. Pure report interpretation is already in `startup-readiness-report.mjs`; a later extraction is described below |
| Overlay driver smoke | 361 | tool resolution, TCP and HTTP/WebDriver, step execution, evidence JSON, report handoff, process cleanup | Node now owns tool resolution, TCP/HTTP/WebDriver, orchestration and artifacts; the PowerShell file is an argument-compatibility wrapper |
| IPC diagnostics | 71 | optional launch, three CLI invocations, verdict printing | Node CLI now owns launch, invocation and verdicts; PowerShell is a compatibility wrapper |
| Timeboxed command | 147 | owned child lifecycle, timeout, C-drive floor sampling, atomic receipt | Audited only; unchanged because Watch Mode smoke consumes it |

The three migrated entry points contained 694 PowerShell lines before this change. Their wrappers are intentionally small and contain no `Get-Process -Name`, `Stop-Process`, or `taskkill` calls. Process termination in the Node core applies only to a `ChildProcess` created by that invocation and uses its exact PID.

## Next-phase design: timeboxed command

Move payload decoding, environment shaping, timeout polling, samples, outcome schema, UTF-8 atomic JSON and exit-code mapping (124 timeout, 125 disk floor, 126 probe failure) to `run-timeboxed-command.mjs`. Keep a Windows adapter only for querying the C: volume and terminating an owned process tree after PID identity validation. Preserve the receipt schema byte-for-byte and switch Watch Mode consumers only after their existing contract tests pass. No file in that path was changed here.

## Windows authority and installer boundary

| Script family | Keep in Windows adapter | Move to cross-platform Node core later |
| --- | --- | --- |
| `collect-install-release-state.ps1` | PnP device queries, service manager state, Authenticode inspection | relative-path normalization, schema construction, deterministic sorting, JSON writing, ordinary SHA-256 |
| `virtual-mic-capture-authority.ps1` | CoreAudio endpoint/capture authority and Windows device correlation | evidence property assertions, canonical JSON, hashes, report/error shaping |
| `windows-overlay-process-authority.ps1` | CIM process creation time, executable identity, descendant and WebView runtime discovery | schema validation, authority comparison and JSON reporting |
| installer driver scripts | PnPUtil/DevCon, WDK/MSBuild discovery, UAC elevation, certificate store, test signing, Secure Boot and driver service operations | manifests, input validation, hashes, JSON receipts, deterministic artifact inventories and report formatting |

Large installer scripts audited were `build-sysvad-driver.ps1` (373 LOC), `install-development-driver.ps1` (362), `test-development-driver.ps1` (314), `virtual-speaker-device.ps1` (390), and `probe-development-driver.ps1` (180). Mechanical Windows operations must remain PowerShell/native; only their data plane should move.

## Deferred integration and zero-overlap proof

This change deliberately does not edit `package.json` or `scripts/testing/powershell-boundaries.json`. After the parallel Watch Mode work lands, update commands to call:

- `node ./scripts/testing/startup-ipc-stress.mjs --mode run`
- `node ./scripts/testing/overlay-driver-smoke.mjs --mode run`
- `node ./scripts/diagnostics/ipc-test.mjs`
- include `scripts/testing/process-orchestration.test.mjs` in the relevant test command

The implementation does not edit Watch Mode live/interactive scripts, `Omni.Testing.WatchMode.*`, strict runtime, local isolation, production coordinator, provider preflight, receipts, or evidence verifier files. Validate this claim with `git diff --name-only` before merge.

## Startup readiness follow-up

Create `startup-readiness-runner.mjs` to own run-directory creation, Vite HTTP warmup, timeout state machine, log buffering and collection assembly. Expose a narrow Windows adapter with three commands: enumerate listener/process identities, wait for the desktop window, and stop a leased process tree. Then reduce `Omni.Testing.Startup.Runner.psm1` to adapter functions or remove it after `measure-startup-readiness.ps1` becomes a wrapper. Preserve the existing `startup-readiness-collection/v1` schema and verify with `measure-startup-readiness.test.mjs` and `startup-readiness-report.test.mjs`.
