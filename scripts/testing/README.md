# Testing Matrix

## Automated checks

Install the pinned Rust coverage toolchain once:

```powershell
npm run coverage:tooling
```

Run the non-administrator base coverage gate:

```powershell
npm run coverage:gate:base
```

Run the complete desktop-shell coverage gate from an administrator PowerShell:

```powershell
npm run coverage:gate
```

The base gate enforces the configured desktop frontend thresholds and a
non-decreasing baseline for the native Bridge and shared Rust crates. The
administrator layer additionally enforces the desktop-shell Rust thresholds.
Rust branch coverage uses the pinned
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

Run the architecture boundary audit:

```powershell
npm run audit:architecture
```

The audit enforces size limits (Rust modules/functions, React
page/screen/workspace files), Rust module wiring, and the retired legacy
gateway methods, plus these frontend boundary rules for `apps/desktop/src`
(test files and `.d.ts` ambient declarations are exempt):

- `@tauri-apps/api` may only be imported inside `runtime/**`; every other
  production source is flagged as `Tauri import outside runtime`.
- Production code must not import `src/mocks/**` (`Mocks import in production
  code`). Shared preset/default data lives in `src/defaults/**`; `src/mocks/**`
  holds test doubles. Test support code (`src/mocks/**` itself and shared test
  helpers under `src/test-utils/**`) is exempt as an importer.
- `runtime/**` must not import `pages/**` or `components/**`
  (`Runtime imports UI layer`) — no reverse layering.
- Tauri command calls funnel through `runtime/desktop-api-v2.ts`; any other
  bare `invoke(...)` or `invoke<T>(...)` call site is flagged as
  `Direct invoke`.

The default (non-strict) mode compares findings against
`scripts/testing/architecture-baseline.json` and fails only on violations not
covered by that baseline; pre-existing debt listed there is reported but
tolerated. Baseline entries are keyed by rule plus normalized file path (no
line numbers), so line drift in an already-listed file does not fail the gate.
Resolved baseline entries are reported as prune candidates. After paying down
debt (or when intentionally accepting a new entry), regenerate the baseline
with `node scripts/testing/audit-architecture-boundaries.mjs
--update-baseline`. `npm run audit:architecture:strict` ignores the baseline
and fails on every violation. The non-strict audit runs in the PR fast-check
workflow and as the first step of `run-quality-gate-auto.mjs`.

## Live LLM integration

Copy `llm-integration.config.example.json` to
`llm-integration.config.json`, provide a local API key, and run:

```powershell
npm run test:llm-integration
```

To exercise only the configured realtime speech model (without text smoke,
catalog, or probe requests), run `npm run test:audio-model-integration`. That
entry has a 300-second process-tree timeout so the roughly two-minute fixture
can be streamed in realtime and finalized; `--timeout-seconds` may lower it or
raise it to at most 600 seconds.

The local config file is ignored by Git. The live suite also runs as part of
`npm run test:desktop-shell`, or can be invoked alone with the command above.
It calls configured text
models through their base URLs and sends the original `watch-mode-en-original.wav` fixture through the configured
DashScope realtime audio model. Optional `catalog`, `probe`, and `speech`
blocks enable model-directory, provider-probe, and realtime speech-synthesis
checks. The suite validates response shape and configured minimum lengths.
Two alternative English fixtures and one fixture for every other supported
project language are documented in `scripts/testing/fixtures/README.md`; use
the existing `--media-path` option to select one for Watch Mode testing.

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
| Virtual microphone output request | Bridge v6 capability, pacing, generation, and exactly-once cue tests | A real target capture application must open the ready 48 kHz mono PCM16 endpoint, capture the unique PCM fingerprint, observe frames, and prove zero physical playback for the cue |
| Storage, snapshots, credentials, diagnostics | Rust repository, credential, and diagnostics tests | Manual diagnostics export |

Host audio-device enumeration, operating-system driver installation, and the
final visible overlay require manual desktop verification because they depend
on Windows devices and native windows.

## Release manual evidence and performance baseline

The three quality-gate artifacts use schema version 2. They are valid only for
the exact current clean Git `HEAD`, expire after 14 days, and must reference
immutable evidence receipts. Arbitrary historical Markdown with a checked
`PASS`, an ancestor build, a dirty checkout, or a receipt whose payload has
changed is rejected.

For a scenario with a registered production authority, assemble its fixed
authority output into a package and then archive that package:

```powershell
node ./scripts/testing/run-desktop-release-evidence.mjs --scenario-id E2E-PROVIDER-CONFIG
node ./scripts/testing/run-desktop-release-evidence.mjs --scenario-id E2E-PROVIDER-PROBE
node ./scripts/testing/run-desktop-release-evidence.mjs --scenario-id E2E-DIAGNOSTICS-EXPORT
npm run collect:release-evidence:real-device-audio
node ./scripts/testing/run-overlay-click-through-release-evidence.mjs --operator "<name>" --operator-notes "<observed target click and passive overlay behavior>"
npm run collect:release-evidence:install:fresh
npm run collect:release-evidence:install:repair
npm run collect:release-evidence:install:uninstall
npm run collect:release-evidence:install:upgrade -- -PreviousVersion <older-signed-version>
npm run collect:release-evidence:install:release-layout
npm run collect:release-evidence:virtual-mic
node ./scripts/testing/archive-release-manual-evidence.mjs --scenario-id <scenario-id> --source <packageDirectory-from-runner-or-assembler>
```

`collect-release-manual-evidence.mjs` is a fail-closed legacy entrypoint: it no
longer accepts `--source` at all. Authority-package assembly is a private
in-process step reached only after the scenario-specific runner has produced
and validated its canonical raw payload. The exported Desktop, overlay, and
virtual-microphone APIs execute those runners themselves and do not accept raw
directories. The real-device and install public APIs also execute their
canonical runners instead of accepting caller-authored raw directories. Their
private assembly step verifies the live Node PID, executable, and canonical
runner entrypoint through `Win32_Process`; `node -e`, `node -p`, stdin scripts,
non-empty `NODE_OPTIONS`, and any other indirect entrypoint fail closed.
All five install scenarios likewise accept only
`run-install-release-evidence.mjs` through the collector's private authority
seam. The runner resolves the canonical signed package for the current clean
HEAD, invokes its production UAC operation for mutating scenarios, and has no
workspace/package/source/dry-run/simulated/skip override. Unit tests use
programmatic dependency injection and never elevate the local machine.
`installer:prepare` first deletes only the commit-scoped
`artifacts/release-build/<HEAD>/target` directory, then force-builds Desktop and
all Bridge binaries with that clean commit. Desktop must contain the embedded
commit and Bridge/service/probe/VMic executables must return it from the
side-effect-free `--build-commit` probe. Their hashes are bound in
`installer-layout.json`, rechecked before signing, and refreshed/revalidated
after Authenticode signing changes the PE bytes; an older `target/release`
executable is never a packaging fallback.
`run-desktop-release-evidence.mjs`
first deletes the canonical `target/release/omni-desktop-shell.exe`, fixes the
Cargo target directory, clears an inherited build target, and rebuilds the
release Desktop from the exact clean HEAD. It then launches one production
Desktop process, waits for that process's renderer
IPC readiness, invoke the existing handlers in the same `AppHandle`, validate
the emitted PID/executable/invocation/bundle authority, require the release
binary's compile-time Git commit to equal the current exact clean `HEAD`, and then call the
assembler through its private authority seam. The real-device runner re-verifies the complete
canonical strict schema-v3 budget-balanced Watch authority and accepts only its fixed
`qwen3.5-omni-flash-realtime/process-exclusion/default-speaker` cell; it does not accept a
manifest path, report directory, dry-run, simulated, or skip override. Each available profile has a fixed
emitter ID/version, evidence artifact kind, payload role set, raw schema,
timestamps, and cross-field invariants. The archive command validates
the package before copying it and binds the receipt to the collector manifest,
collection ID, exact clean HEAD, script hash, payload hashes, and recomputed
scenario summary. Copy the emitted receipt path and SHA-256 into the matching fixed scenario in
the generated E2E or install report. Manual E2E has exactly six scenarios and
install regression has exactly five.

The virtual-microphone runner applies the same rebuild rule to the canonical
`target/release/omni-virtual-mic-target-capture.exe` and
`target/release/omni-bridge-service.exe`: it deletes both old outputs, fixes
`CARGO_TARGET_DIR`, clears `CARGO_BUILD_TARGET`, builds both bins with the
current commit embedded, and requires both `--build-commit` probes to equal
the exact clean HEAD before starting capture. Its fourth raw artifact,
`emitter-result.json`, binds those paths, hashes, commits and PIDs to the three
native capture artifacts. Generic VMic `--source` packaging is rejected.

The fixed manual collector inputs are:

| Scenario | Authority status | Required production output |
| --- | --- | --- |
| `E2E-PROVIDER-CONFIG` | Ready; same-process production Desktop emitter | `emitter-result.json`, production config snapshot, Windows Credential Manager status-only check, and invocation-bound full diagnostics bundle |
| `E2E-PROVIDER-PROBE` | Ready; same-process production Desktop emitter, live Provider credential required | `emitter-result.json`, raw production Provider probe result with `available` verdict, and invocation-bound full diagnostics bundle |
| `E2E-REAL-DEVICE-AUDIO` | Ready; fixed canonical strict-v2 Watch cell from the current exact clean HEAD | Cell authority receipt and complete raw inventory, actual MMDevice identity, Desktop/media/recorder/Bridge PIDs, physical/reference/source PCM, physical recording, process-exclusion fingerprints, Watch cue lifecycle, and Bridge playback lifecycle |
| `E2E-OVERLAY-CLICK-THROUGH` | Ready; dedicated Windows OS/WebDriver authority runner | Current-clean-HEAD release Desktop and native target helper, raw WebDriver and Win32 timelines, distinct Desktop/overlay/target PID+HWND authority, real `WM_NCHITTEST=HTTRANSPARENT`, `SendInput` click receipt, foreground checks, screen PNG/hash, and named operator observation |
| `E2E-DIAGNOSTICS-EXPORT` | Ready; same-process production Desktop emitter | `emitter-result.json`, production handler receipt, canonical full export metadata, copied diagnostics bundle, and invocation/PID/hash cross-checks |
| `E2E-VIRTUAL-MIC-CAPTURE` | Ready; dedicated current-HEAD rebuild runner | `emitter-result.json` plus the native `omni-virtual-mic-target-capture/0.1.0` WAV/probe/runtime output; the receipt binds fixed collector/Bridge paths, `--build-commit`, hashes, PIDs, raw authority, and payload hashes |
| `INSTALL-FRESH` | Ready; production signed-package UAC runner | Canonical package/signature authority, absent before-state, elevated operation JSON/log, healthy after-state, Bridge v6/tone/real virtual-mic probe, and raw WAV/probe/runtime files |
| `INSTALL-REPAIR` | Ready; production signed-package UAC runner | Canonical package/signature authority, healthy before/after states, elevated repair JSON/log, and the complete post-repair audio health package |
| `INSTALL-UNINSTALL` | Ready; production signed-package UAC runner | Canonical package/signature authority, healthy before-state, elevated uninstall JSON/log, and an after-state proving complete PnP/endpoint/DriverStore/service/runtime/process absence |
| `INSTALL-UPGRADE` | Ready; two canonical signed packages plus production UAC runner | Current and historical package/signature authority, old healthy before-state, elevated install JSON/log, new healthy after-state, different source commit/SYS, v6 ABI, and complete audio health package |
| `INSTALL-RELEASE-LAYOUT` | Ready; read-only canonical signed-layout runner | Exact package/signature/inventory/checksum/signing-target/timestamp authority bound to the current clean HEAD; no UAC or machine mutation |

The three Desktop scenarios, canonical real-device assembler, dedicated
overlay OS/WebDriver runner, current-HEAD virtual-microphone rebuild runner, and five
install/layout runners are registered production authorities. Hand-written
operation/probe/layout JSON still cannot be packaged or archived as a release
PASS. Test code has explicitly labelled private dependency seams for validator
coverage, but production CLI and default validation reject generic sources and
test-fixture authority.

`E2E-VIRTUAL-MIC-CAPTURE` passes only when
the v6 capability is `supported=true` and `status=ready`, the endpoint name is
present with format `48000Hz/mono/pcm16`, and a real target capture application
opens that endpoint. Its receipt directory must contain exactly auditable
inputs named `virtual-mic-capture.wav`, `virtual-mic-capture-probe.json`, and
`runtime-snapshot.json`. The validator parses the WAV and independently binds
both JSON artifacts to the exact native collector/version, three distinct
collector/capture-child/Bridge PIDs, protocol v6, Bridge instance/session,
endpoint ID/name, raw before/after counters and recomputed deltas, raw status
timeline, cue lifecycle, WAV hash/frame count, and fingerprint PCM window/hash.
The probe and runtime snapshot must both contain the exact 24,000-sample
pre-injection PCM as 96,000 lowercase hexadecimal characters and its SHA-256.
The shared authority first recomputes that expected hash, then searches the
entire captured WAV for exactly one full-length match with at most one PCM16
LSB of quantization error per sample and independently verifies the 997 Hz
spectral component. It recomputes the start frame and does not trust a declared
`detected` flag or `startFrame`. Older three-file captures without the expected
PCM body intentionally fail closed and must be recollected with the current
binary.
It requires positive captured/Bridge frames, zero physical-playback frames for
the cue, and exactly-once queued/started/completed lifecycle.
`unsupported` or `failed` remains useful diagnostic evidence but cannot pass
the stable release scenario. Fake Bridge counters alone are not endpoint
capture evidence.

Do not type performance measurements into the pending JSON template. First run
the canonical strict Watch matrix on the required default-speaker and separate
USB endpoints. Bluetooth remains an optional diagnostic endpoint. Every live matrix cell now writes `system-metrics.json`
with raw one-second samples for the Desktop process tree. The budget-balanced
release plan first runs 6 five-minute local-isolation cells with the Provider
disabled, then 6 three-minute pairwise live cells and 2 ten-minute model
stability cells. The paid live budget is therefore 38 minutes. After all
authorities pass, assemble the baseline:

```powershell
node ./scripts/testing/assemble-performance-baseline.mjs --operator "<name>"
```

The assembler accepts only
`artifacts/testing/watch-mode-live/latest-successful-watch-mode-strict-matrix.json`
from the same exact clean `HEAD`. Production assembly and validation rerun the
complete schema-v3 balanced strict authority verifier; the verification receipt is only
an index, not authority by itself. The archive binds the canonical manifest,
its strict source manifest and verification receipt, every per-cell authority
receipt, the 6-cell zero-LLM local authority, and all 8 paid live
`report.json` and `system-metrics.json` files by path, byte
count, and SHA-256. Validation rebuilds every authorized Watch report, derives
the provider and subtitle p95 values from raw cue timestamps, and independently
recomputes TTS latency, process-tree CPU p95, peak memory, dropout evidence, and
the shorter duration of the two 10-minute stability cells. Legacy canonical manifests, self-reported
canonical PASS, missing receipts/raw files, and rehashed aggregate summaries
are rejected.

Evidence collection boundaries:

| Artifact | Command or action | Prerequisites | Typical duration | Verifiable output |
| --- | --- | --- | --- | --- |
| Manual E2E | Run `collect:release-evidence:desktop` for the three Desktop-backed scenarios, `collect:release-evidence:real-device-audio` after the strict matrix, `collect:release-evidence:overlay` on an interactive Windows desktop, and `collect:release-evidence:virtual-mic` | Clean exact HEAD, release Desktop binary, configured live Provider credential for Provider scenarios, complete current-HEAD strict matrix, native virtual microphone ready, an installed Microsoft Edge WebView2 runtime, network access for the runner to install pinned `tauri-driver` 2.0.6 with `--locked` and fetch the exactly matching Microsoft-signed WebDriver into `artifacts/tooling/overlay-click-through`, and a named overlay operator on an unlocked interactive desktop | Desktop/diagnostics, vmic, and overlay take minutes; the real-device assembler takes seconds after the balanced matrix | Six independently validated scenario receipts; stable release requires all six |
| Canonical performance source | `node ./scripts/testing/run-watch-mode-live-matrix.mjs --device-profiles <json> --skip-driver-repair` | Clean exact HEAD, production binaries, available DashScope credential, one verified default-speaker endpoint and one distinct USB endpoint, a working virtual-driver route; elevation only when the installed driver/device requires it | 68 minutes raw collection (30 zero-LLM + 38 paid live), normally 1.25–2 hours with build/readiness/post-processing | Canonical strict manifest, 6 local-isolation authorities, 8 passed live `report.json`, and 8 raw `system-metrics.json` files |
| Performance assembly | `node ./scripts/testing/assemble-performance-baseline.mjs --operator "<name>"` | The complete canonical matrix above, still on the same clean HEAD | Seconds to about one minute | Receipt-backed `desktop-perf-baseline-*.json`; CPU/memory/latency/dropout/duration are recomputed |
| Install regression | `npm run test:install-regression`; then run each `collect:release-evidence:install:*` command and archive its returned package directory | Windows x64 UAC test machine, exact current-clean-HEAD canonical signed package, RFC3161 timestamps, and an older canonical signed package for upgrade | 20-40 minutes plus operator review | Five independently recomputed collector packages/receipts; schema-shaped files and prose cannot satisfy a scenario |

The performance assembler is non-interactive after a valid matrix exists. The
matrix itself and the two Markdown reports cannot be produced truthfully on a
headless machine without the named credentials, endpoints, UAC state, and
human observations. A missing required observation is a release blocker, not
permission to use a manually assembled source directory.

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
  steady playback and do not grow continuously. Bridge log lines use the same
  format as app.log — `{timestamp} [{LEVEL}] [bridge] {source} - {message}`
  with a `yyyy-MM-dd HH:mm:ss.fff` leading timestamp — and the pacer summary
  message is kept verbatim after the prefix.
- Every app.log line ends with a ` sid=<value>` token carrying the
  application-run session id; bridge-service.log lines carry the derived
  `sid=bridge-<appSid>-<startMs>` token after the `bridge.init` handshake.
  Filtering all three log sources (app.log, bridge-service.log, forwarded
  frontend entries inside app.log) by the same `sid=` substring isolates one
  application run. The five `*_v2` commands additionally log
  `api_v2.request` / `api_v2.response` lines with a `requestId=<value>`
  detail that matches the `requestId` field on the v2 response envelope
  (`ServiceErrorV2.details.requestId` on failures).

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

Re-check strict release evidence from the manifest emitted by one completed
matrix invocation. Strict verification deliberately refuses to scan the
output root for older reports:

```powershell
npm run test:watch-mode-evidence:strict
```

The npm command reads
`artifacts/testing/watch-mode-live/latest-successful-watch-mode-strict-matrix.json`.
Only a successful scoped verification of the exact budget-balanced release plan may
atomically replace that canonical manifest. A strict matrix must start and
finish on one clean Git checkout. Every report and matrix manifest records an
explicit `provenance` object, and strict verification requires its
`headCommit` to equal the current `HEAD` exactly with `worktreeClean=true` and
`dirtyEntryCount=0`. An ancestor commit, tracked changes, or untracked source
files cannot satisfy release provenance; clean the checkout and rerun the full
matrix instead.

The canonical file is a schema-v3 authority manifest, not a directory list.
Before collection the matrix rebuilds the Desktop/AEC3, Bridge probes/media
injector, realtime diagnostic, and SYSVAD package from that exact checkout.
Each cell then records a fixed raw-artifact inventory with byte counts and
SHA-256 hashes, plus hashes for the executed binaries and installed-driver
identity. The strict verifier rejects `--run-directories`, report-only cells,
changed directories/files, stale receipts, and summary fields that do not
match a fresh classification of the bound logs, PCM/WAV, Watch report, device
probe, and process metrics. Canonical publication additionally requires the
verification receipt emitted after that complete raw re-check; the receipt is
an index and never substitutes for re-running the raw authority verifier.

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

Run the strict two-model, three-route, two-physical-device matrix on Windows. The
strict entry requires `--device-profiles` to explicitly contain exactly one
`default-speaker` and one distinct `usb` profile; it never falls back
to the default endpoint. Matrix options are double-dash Node flags (they
survive `npm run ... --` on npm 11):

```powershell
node .\scripts\testing\run-watch-mode-live-matrix.mjs --device-profiles .\artifacts\testing\watch-mode-device-profiles.json --skip-driver-repair --allow-elevated-desktop-launch
```

With npm 11 under PowerShell, forwarding these Node options through the npm
alias requires two separators: `npm run test:watch-mode-live:matrix -- --
--device-profiles ...`. Invoking the Node entry point directly, as above,
avoids npm-version-specific argument forwarding.

The JSON file must contain `{"deviceProfiles":[...]}` with the two required device
classes above. The USB profile requires an explicit MMDevice id and
expected endpoint names. For a one-device live diagnostic, invoke
`run-watch-mode-live.ps1` directly or pass `--diagnostic-single-device`; that
mode is explicitly non-strict. The matrix rejects `-DryRun`; fixture-backed
self-tests must use `npm run test:watch-mode-live:dry-run` and can never
publish release evidence.

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
playback notes. Each successful release-shaped matrix publishes the canonical
manifest only after its scoped verifier passes. Release verification uses
`npm run test:watch-mode-evidence:strict` to re-check exactly those recorded
run directories for `qwen3.5-omni-flash-realtime` and
`qwen3.5-livetranslate-flash-realtime`; `npm run quality:gate` does not launch
the live hardware path.
