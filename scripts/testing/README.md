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

The gate enforces 100% line, function, and branch coverage independently
for the desktop frontend, legacy Node bridge workspace, desktop-shell Rust
crate, and native Bridge Rust crate. Rust branch coverage uses the pinned
`nightly-2026-06-01` toolchain with `cargo-llvm-cov 0.8.6`. Entrypoints,
generated assets, vendored SYSVAD sources, and thin platform adapters remain
outside the measured core logic surface.

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
models through their base URLs and sends `Test.mp3` through the configured
DashScope realtime audio model. Optional `catalog`, `probe`, and `speech`
blocks enable model-directory, provider-probe, and realtime speech-synthesis
checks. The suite validates response shape and configured minimum lengths.

## Feature inventory

| Surface | Automated evidence | Live or manual evidence |
| --- | --- | --- |
| Provider text translation and streaming deltas | Rust gateway protocol tests | Live LLM `providers[].smoke` |
| Provider model directory | Rust endpoint parser tests | Live LLM `providers[].catalog` |
| Provider health and latency probe | Rust routing tests | Live LLM `providers[].probe` |
| Realtime audio transcription and translation | Rust websocket protocol tests | Live LLM `audio` with `Test.mp3` |
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
- `%LOCALAPPDATA%\OmniTranslate\bridge-runtime\bridge-service.log` contains
  `source pacer summary` entries whose `queuedFrames` remain near zero during
  steady playback and do not grow continuously.
