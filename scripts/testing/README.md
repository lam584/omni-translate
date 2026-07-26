# Testing Matrix

## Automated checks

Install the pinned Rust coverage toolchain once:

```powershell
npm run coverage:tooling
```

Run the repository coverage gate from an administrator PowerShell:

```powershell
npm run coverage:gate
```

The gate enforces the configured desktop frontend coverage thresholds and
100% line, function, and branch coverage for the desktop-shell Rust crate
and native Bridge Rust crate. Rust branch coverage uses the pinned
`nightly-2026-06-01` toolchain with `cargo-llvm-cov 0.8.6`. Entrypoints,
router, overlay, schema/contract files, generated assets, vendored SYSVAD
sources, and thin platform adapters are explicitly governed by each local
coverage config rather than claimed as implicit 100% evidence.

Run Rust protocol, routing, and audio worker tests:

```powershell
npm run test:desktop-shell
```

The Rust suite includes the live LLM integration test. It reads
`scripts/testing/llm-integration.config.json` by default, so this command makes
real provider network calls and requires local credentials.

## Live LLM integration

Copy `llm-integration.config.example.json` to
`llm-integration.config.json`, provide a local API key, and run:

```powershell
npm run test:llm-integration
```

The local config file is ignored by Git. The live suite also runs as part of
`npm run test:desktop-shell`, or can be invoked alone with the command above.
It calls configured text
models through their base URLs and sends the original `watch-mode-en-original.wav` fixture through the configured
DashScope realtime audio model. Optional `catalog`, `probe`, and `speech`
blocks enable model-directory, provider-probe, and realtime speech-synthesis
checks. The suite validates response shape and configured minimum lengths.

## Feature inventory

| Surface | Automated evidence | Live or manual evidence |
| --- | --- | --- |
| Provider text translation and streaming deltas | Rust gateway protocol tests | Live LLM `providers[].smoke` |
| Provider model directory | Rust endpoint parser tests | Live LLM `providers[].catalog` |
| Provider health and latency probe | Rust routing tests | Live LLM `providers[].probe` |
| Realtime audio transcription and translation | Rust websocket protocol tests | Live LLM `audio` with the original WAV fixture |
| Realtime speech synthesis | Rust audio-delta tests | Live LLM `audio.speech` |
| Watch-mode route and overlay auto-show selection | Rust audio event tests and session page tests | Manual desktop watch-mode playback |
| Subtitle cue rendering and overlay controls | Overlay page tests | Manual desktop overlay inspection |
| Audio routing configuration | Routing page tests and Rust route-spec tests | Manual device selection |
| Virtual microphone bridge IPC | Bridge service named-pipe tests | Manual driver installation and device playback |
| Storage, snapshots, credentials, diagnostics | Rust repository, credential, and diagnostics tests | Manual diagnostics export |

Host audio-device enumeration, operating-system driver installation, and the
final visible overlay require manual desktop verification because they depend
on Windows devices and native windows.

## Manual runtime verification

After rebuilding and relaunching the desktop app, start watch mode with the
virtual audio driver and play audio. Confirm that:

- The subtitle overlay becomes visible without manually toggling it.
- Source and translated subtitle cues appear.
- Original audio plays continuously without periodic fast playback or pauses.
- Translated speech is audible after translated subtitle cues appear.
- `artifacts/diagnostics/logs/app.log` contains
  `watch route ensured subtitle overlay visible`.
- `artifacts/diagnostics/logs/bridge-service.log` contains
  `source pacer summary` entries whose `queuedFrames` remain near zero during
  steady playback and do not grow continuously.

## Startup readiness timing

Measure how long the desktop shell takes from launch to the main window, and
from the main window to usable bootstrap readiness:

```powershell
npm run perf:startup-readiness
```

The runner starts `npm run dev:tauri --workspace @omni/desktop`, injects a
unique `VITE_OMNI_STARTUP_MEASURE_RUN_ID`, polls Windows for the `Omni
Translate` main window, then waits for the frontend `startup.readiness_ready`
diagnostic marker. Each run writes `report.json`, `report.md`, and captured
Tauri dev stdout/stderr under
`artifacts/testing/startup-readiness/<run-id>/`.
Reports enforce a maximum `windowToReadyMs` of 10,000 ms and treat bootstrap
error steps as not ready.

Validate the startup-readiness threshold tests:

```powershell
npm run test:startup-readiness
```

Validate the latest measured report:

```powershell
node ./scripts/testing/verify-startup-readiness.mjs
```

Use `-NoStop` when you want to keep the app open after the measurement:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./scripts/testing/measure-startup-readiness.ps1 -NoStop
```

If Vite is already running on the configured dev port, measure only the Tauri
window-to-ready path against that server:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./scripts/testing/measure-startup-readiness.ps1 -UseExistingDevServer
```

## Watch-mode live diagnostics

Run the report classifier tests:

```powershell
npm run test:watch-mode-report
```

Check the latest complete live evidence without launching hardware diagnostics:

```powershell
npm run test:watch-mode-evidence
```

Check the strict release evidence gate. This requires the latest complete
`scripts/testing/fixtures/watch-mode-en-original.wav` live run for both required Watch Mode models:

```powershell
npm run test:watch-mode-evidence:strict
```

Run the fixture-backed dry run without administrator permissions:

```powershell
npm run test:watch-mode-live:dry-run
```

The dry run automatically generates the ignored built-in
`scripts/testing/fixtures/watch-mode-live/pass` fixture when it is missing or
incomplete. Regenerate it explicitly with:

```powershell
npm run generate:watch-mode-live-fixtures
```

Run the echo-cancel variant with:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./scripts/testing/run-watch-mode-live.ps1 -DryRun -FeedbackLoopPrevention echo-cancel
```

npm 11 swallows single-dash options after `npm run ... --` and forwards only
their values, so PowerShell-style runner options cannot be passed through the
npm scripts. The runner fails fast when it detects such a misbound value. To
keep using `npm run test:watch-mode-live` or the dry-run script, set the
environment-variable overrides instead:

```powershell
$env:OMNI_WATCH_MODE_LIVE_FEEDBACK_LOOP_PREVENTION = "echo-cancel"
npm run test:watch-mode-live:dry-run
```

Only the built-in `pass` fixture is generated automatically. A missing custom
fixture remains an error; select one with `-Fixture` and `-FixtureRoot` on a
direct `powershell.exe -File` invocation, or with `OMNI_WATCH_MODE_LIVE_FIXTURE`
and `OMNI_WATCH_MODE_LIVE_FIXTURE_ROOT` when going through `npm run`.

Run the live watch-mode diagnostic on Windows:

```powershell
npm run test:watch-mode-live
```

Run the strict two-model matrix on Windows. Matrix options are single-dash
PowerShell parameters, so invoke the script directly instead of going through
`npm run ... --`:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ./scripts/testing/run-watch-mode-live-matrix.ps1 -SkipDriverRepair -AllowElevatedDesktopLaunch -PostPlaybackWaitSeconds 120 -SessionReadyTimeoutSeconds 90
```

The live command builds the native bridge, probes the virtual speaker driver,
attempts an explicit elevated repair if the probe fails, starts the desktop
shell, plays the full original WAV fixture, copies `app.log` and
`bridge-service.log`, and writes `report.json` plus `report.md` under
`artifacts/testing/watch-mode-live/<timestamp>/`. Live runs also refresh
`artifacts/testing/watch-mode-live/latest-watch-mode-live.json` with the
latest report path, verdict, timestamp, failure layer, and model id.

The report separates failures into `driver`, `wasapi`, `bridge`,
`physicalOutput`, `physicalOutputContent`, `speechSegmentation`,
`strictContent`, `app`, and `provider` layers. The `strictContent` layer is
applicable to full original-fixture live runs and checks deterministic Chinese
reference coverage, required concepts, forbidden numeric mistranslations, at
least eight final subtitle writes, at least eight queued translated speech
segments, and at least eight played translated speech segments.

Agents should read the timestamped `report.json` under
`artifacts/testing/watch-mode-live/` first, then inspect the listed suspect
files and copied logs instead of relying on root-level `report.json` or manual
playback notes. Release verification uses
`npm run test:watch-mode-evidence:strict` as an independent strict evidence
gate for `qwen3.5-omni-flash-realtime` and
`qwen3.5-livetranslate-flash-realtime`; `npm run quality:gate` does not launch
the live hardware path.
