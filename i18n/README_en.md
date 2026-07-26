# Omni Translate

<h4 align="center">
    <p>
        <a href="../README.md">简体中文</a> |
        <b>English</b> |
        <a href="README_es.md">Español</a> |
        <a href="README_ar.md">العربية</a> |
        <a href="README_pt.md">Português</a> |
        <a href="README_ru.md">Русский</a> |
        <a href="README_hi.md">हिन्दी</a> |
        <a href="README_bn.md">বাংলা</a> |
        <a href="README_de.md">Deutsch</a> |
        <a href="README_id.md">Bahasa Indonesia</a> |
        <a href="README_ko.md">한국어</a> |
        <a href="README_fr.md">Français</a> |
        <a href="README_vi.md">Tiếng Việt</a> |
        <a href="README_ja.md">日本語</a> |
        <a href="README_te.md">తెలుగు</a> |
        <a href="README_ta.md">தமிழ்</a> |
        <a href="README_mr.md">मराठी</a> |
        <a href="README_th.md">ไทย</a> |
        <a href="README_fil.md">Filipino</a> |
        <a href="README_tr.md">Türkçe</a>
    </p>
</h4>

Omni Translate is a Windows desktop application for real-time audio translation. It targets workflows such as video subtitle translation, game voice translation, and bidirectional voice room or meeting translation. The app connects a virtual audio driver, native bridge, Rust core runtime, and unified AI gateway to process audio capture, ASR, LLM translation, TTS, subtitle rendering, and playback routing.

## Features

- **Real-time subtitle translation**: Captures system or microphone audio, recognizes speech, and renders translated subtitles in the main window and overlay.
- **Floating subtitle overlay**: A transparent, frameless, always-on-top window designed to sit over videos, games, or meeting apps.
- **Bidirectional voice translation**: Supports watch, game, and voice room routing modes for inbound subtitles/speech and outbound virtual microphone output.
- **Virtual audio driver**: Windows SYSVAD WaveRT-based virtual audio driver connected to user mode through IOCTL and a shared ABI.
- **Rust Native Bridge**: `apps/bridge-service-native` is the only production bridge implementation, handling WASAPI, Named Pipe IPC, audio frames, and driver communication.
- **Unified AI Gateway**: Template-driven DashScope and OpenAI-compatible provider integration with HTTP, streaming HTTP, and WebSocket transports.
- **Glossary management**: Imports, exports, merges, and prioritizes domain glossary packages, then injects them into the translation prompt flow.
- **Secure credential storage**: API keys and other secrets are stored in Windows Credential Manager instead of plaintext business configuration.
- **Diagnostics and quality gates**: Driver health probes, model traces, log export, Watch Mode live-link tests, and release quality gates.
- **20 UI languages**: Current locale resources cover `ar`, `bn`, `de`, `en`, `es`, `fil`, `fr`, `hi`, `id`, `ja`, `ko`, `mr`, `pt`, `ru`, `ta`, `te`, `th`, `tr`, `vi`, and `zh-CN`.

## Quick Start

### Prerequisites

- **Node.js** >= 20
- **Rust stable**, edition 2021
- **Windows 10/11**
- **Visual Studio 2022 Build Tools + Desktop development with C++**, required when building the Tauri desktop shell and the Native Bridge; `cl.exe` and `link.exe` must be available on the command line
- **WDK 10.0.26100**, only required for building the virtual audio driver
- Loading development drivers requires Windows TESTSIGNING mode; normal frontend preview does not require the driver or administrator privileges

### Install and Run

```bash
# 1. Clone the repository
git clone <repo-url>
cd omni-translate

# 2. Install dependencies per package-lock.json
npm ci

# 3. Start the frontend browser preview
npm run dev:desktop

# 4. Start the full Tauri desktop app
npm run dev:desktop-shell
```

Browser preview mode automatically uses the mock runtime, making it suitable for UI development and page checks. The full desktop app starts the Tauri/Rust runtime and only triggers elevation when driver installation or repair actions are involved.

Before first launching the full desktop shell, it's recommended to open the repository from Visual Studio 2022's **Developer PowerShell** or **x64 Native Tools Command Prompt**. If a plain PowerShell session reports `link.exe not found`, load the MSVC environment first:

```powershell
& "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\Launch-VsDevShell.ps1" -Arch amd64 -HostArch amd64
npm run dev:desktop-shell
```

`dev:desktop-shell` first builds a release Native Bridge, then starts Vite, the Rust Core, and the desktop window through Tauri dev; the script requests UAC elevation. The first Rust build needs to download and compile dependencies, so it takes noticeably longer than later launches.

### Common Commands

| Command | Description |
| --- | --- |
| `npm run dev:desktop` | Start the React/Vite frontend dev server |
| `npm run dev:desktop-shell` | Start the full Tauri desktop app through the elevation script |
| `npm run dev:desktop:fast` | Skip the release Native Bridge rebuild and elevation, reusing the Cargo incremental cache for everyday desktop iteration |
| `npm run lint:desktop` | Run ESLint for the desktop frontend |
| `npm run check:desktop` | Run TypeScript type checking |
| `npm run build:desktop` | Build frontend assets |
| `npm run check:desktop-shell` | Check the Tauri Rust backend |
| `npm run build:desktop-shell` | Build the full Tauri app |
| `npm run build:bridge-service-native` | Build the Rust Native Bridge Service |
| `npm run test:all` | Run the full test entrypoint |
| `npm run test:contracts` | Verify frozen contracts |
| `npm run test:watch-mode-live:dry-run` | Run Watch Mode live-link dry-run |
| `npm run quality:gate:auto` | Run the automated quality gate |
| `npm run quality:gate:release` | Run the release quality gate |
| `npm run driver:build-sysvad` | Build the SYSVAD virtual audio driver |
| `npm run driver:install` | Install the development driver |
| `npm run driver:test` | Probe development driver status |
| `npm run driver:uninstall` | Uninstall the development driver |
| `npm run release:prepare` | Run the release preparation pipeline |

## Architecture

```text
┌────────────────────────────────────────────────────────────┐
│ 1. Desktop Shell                                            │
│    Tauri 2 + React 19 + TypeScript 6 + Vite 8/Rolldown      │
│    Main window, subtitle overlay, routing, settings,        │
│    diagnostics, provider pages                              │
├────────────────────────────────────────────────────────────┤
│ 2. Rust Core Runtime                                        │
│    Tauri commands/events, session orchestration, storage,    │
│    diagnostics, tray integration                            │
├────────────────────────────────────────────────────────────┤
│ 3. Audio Layer                                              │
│    WASAPI + cpal + rodio, system/mic capture, VAD,           │
│    segmentation, mixing                                     │
├────────────────────────────────────────────────────────────┤
│ 4. AI Gateway                                               │
│    reqwest + tungstenite, ASR / Translation / TTS providers  │
│    DashScope and OpenAI-compatible templates, probes, errors │
├────────────────────────────────────────────────────────────┤
│ 5. Native Bridge Service                                    │
│    Rust sidecar, WASAPI, Named Pipe IPC, audio frames,       │
│    driver IOCTL                                             │
├────────────────────────────────────────────────────────────┤
│ 6. Driver / Installer                                       │
│    SYSVAD WaveRT virtual audio driver, install, rollback,    │
│    repair, health probing                                   │
└────────────────────────────────────────────────────────────┘
```

## Directory Structure

```text
omni-translate/
├── apps/
│   ├── desktop/                    # Tauri desktop application
│   │   ├── src/                    # React frontend
│   │   │   ├── components/         # Shared UI components
│   │   │   ├── i18n/               # 20 UI locale resources
│   │   │   ├── pages/              # Session, routing, provider, glossary, settings, diagnostics pages
│   │   │   ├── runtime/            # Frontend runtime/IPC adapters
│   │   │   ├── schema/             # TypeScript contracts and types
│   │   │   └── stores/             # Zustand state
│   │   └── src-tauri/              # Rust desktop shell
│   │       └── src/
│   │           ├── audio/          # Audio engine, STT, TTS, translation routing, realtime providers
│   │           ├── bridge/         # Bridge/driver installation and IPC contracts
│   │           ├── diagnostics/    # Logs, traces, diagnostic state
│   │           ├── provider/       # AI Gateway, provider templates, HTTP/WS transport
│   │           ├── runtime/        # Windows, tray, runtime state
│   │           └── storage/        # SQLite repository and credential handling
│   └── bridge-service-native/      # Rust Native Bridge Service, only production bridge implementation
├── crates/                         # Shared libraries for the root Cargo workspace
│   ├── omni-bridge-protocol/       # Shared pipe protocol between Desktop and Native Bridge
│   └── omni-logging/               # Shared non-blocking logging pipeline
├── drivers/
│   └── windows-virtual-mic/        # SYSVAD WaveRT virtual audio driver
│       ├── include/                # Shared Driver/Bridge IOCTL ABI
│       ├── package/                # Driver package metadata
│       └── sysvad/                 # Driver source modified from the Microsoft SYSVAD sample
├── scripts/
│   ├── development/                # Development launch scripts
│   ├── diagnostics/                # Diagnostic tools
│   ├── installer/                  # Driver build, install, uninstall, repair, probe
│   ├── release/                    # Release verification, manifest, packaging, signing manifest
│   └── testing/                    # Tests, coverage, quality gates, Watch Mode links
├── docs/                           # Architecture, quality, project docs, provider/API references
└── artifacts/                      # Build outputs, logs, diagnostic output
```

## Core Flows

### Inbound Translation (Watch / Subtitle Scenarios)

```text
System audio
  → Virtual audio driver / WASAPI capture
  → Native Bridge Service
  → Desktop Rust Audio Layer
  → VAD / segmentation
  → ASR
  → Translation Provider
  → Subtitle rendering (main window + overlay)
  → Optional TTS
  → Local speaker / monitor output
```

### Outbound Translation (Voice Room / Meeting / Game Scenarios)

```text
Microphone
  → Desktop Rust Audio Layer
  → VAD / segmentation
  → ASR
  → Translation Provider
  → TTS
  → Native Bridge Service
  → Virtual audio driver
  → Target app reads the virtual microphone / virtual endpoint
```

### Latency and Degraded Modes

- Subtitles and dubbed speech are separate scheduling results; subtitles are committed first.
- When provider latency exceeds budget, `latency-high` is emitted, subtitles continue, and TTS moves to deferred/queued state.
- When provider probing marks a provider as unsuitable for real time, dubbed speech is disabled by default and the subtitle-first path remains active.
- Driver or Bridge failures do not block app startup; subtitles, local playback, and diagnostics should remain available in degraded mode.

## Tech Stack

| Layer | Technology |
| --- | --- |
| Frontend | React 19.2.x, TypeScript 6.0.x, Vite 8.x, Rolldown, CSS |
| Desktop shell | Tauri 2.x, `@tauri-apps/api`, `@tauri-apps/cli` |
| State and routing | Zustand 5.x, react-router-dom 7.x |
| Internationalization | i18next 26.x, react-i18next 17.x, i18next-browser-languagedetector |
| Frontend testing | Vitest 4.x, jsdom 29.x, ESLint 10.x |
| Rust runtime | Rust 2021, Serde, Tauri commands/events |
| Provider networking | reqwest 0.13, tungstenite 0.29, rustls |
| Storage and credentials | rusqlite 0.40 bundled SQLite, keyring 4, Windows Credential Manager |
| Audio | cpal 0.17, rodio 0.22, wasapi 0.23, hound, minimp3 |
| System APIs | windows-sys 0.61 |
| Native Bridge | Rust sidecar, WASAPI, Named Pipe, IOCTL ABI |
| Driver | Windows SYSVAD WaveRT virtual audio driver |
| Scripts | PowerShell, Node.js release/testing scripts |

## Contracts and Data Boundaries

The project currently maintains four frozen contract areas:

1. **Provider Contract**: Provider metadata, auth references, request parameters, streaming events, error structures, and probe results.
2. **Audio Contract**: System audio, microphone, PCM frames, segments, mixing, latency compensation, and push-to-talk state.
3. **Driver Bridge Contract**: Initialization, audio frames, state queries, error events, and shutdown protocol across Desktop, Native Bridge, and driver.
4. **OBS Integration Contract**: Reserved connection and output boundary for future OBS subtitle overlay and scene trigger support.

Structured configuration uses SQLite as the main source of truth. Sensitive credentials are stored in Windows Credential Manager. Logs, caches, glossary packages, and temporary audio files are kept in separate directories.

## Quality and Testing

- `npm run verify:desktop`: desktop frontend lint, typecheck, test, and build.
- `npm run test:desktop-shell`: Tauri Rust backend tests.
- `npm run test:bridge-service-native`: Native Bridge Rust tests.
- `npm run test:contracts`: TypeScript/Rust/script frozen contract verification.
- `npm run quality:gate:auto`: automated quality gate.
- `npm run quality:gate:release`: release quality gate with manual verification entrypoints.
- `npm run test:watch-mode-report` / `npm run test:watch-mode-live:*`: Watch Mode reports, evidence, and live-link test entrypoints.

## Development

### Frontend Development

Use `npm run dev:desktop` to develop the frontend in a browser. In non-Tauri environments, the runtime layer returns mock data so pages and interactions can be checked without installing the driver or starting the Rust backend.

### Desktop Shell Development & Testing

Anything touching `invoke`, events, SQLite, Windows Credential Manager, the Native Bridge, system audio, or the subtitle overlay must be tested inside the Tauri desktop shell — a browser mock preview cannot substitute for it.

```powershell
# First launch, or after changing the Rust Core, Native Bridge, or Cargo configuration
npm run dev:desktop-shell

# Everyday frontend/desktop iteration once a standard build has already succeeded
npm run dev:desktop:fast
```

`dev:desktop:fast` skips the release Native Bridge rebuild and UAC elevation that `dev:desktop-shell` performs: it starts and pre-warms the Vite server on port `4173`, then enters `tauri dev` and reuses the Cargo incremental cache. You cannot run the debug EXE directly, because the Tauri CLI is also responsible for providing the WebView IPC runtime context. Still use `dev:desktop-shell` for the first run, after Native Bridge source changes, or whenever you need to verify the elevation flow.

Once the desktop shell has started, confirm at least the following signals on the Diagnostics page:

- `isTauri`, `IPC Bridge`, `window.ipc`, and `isTauriRuntime` are all `true`.
- The bridge status is `tauri-shell`, and the normalized environment state is not `runtime-error`.
- Storage status is `ready`, the schema version is at least `1`, and the credential backend is not `browser-preview`.
- `artifacts/diagnostics/logs/app.log` shows `debug_ipc_ping`, with no `startup.ipc_watchdog_reload` after startup.

Stop the desktop dev process before running Rust checks, so a long-running `tauri dev` doesn't hold the Cargo build lock:

### Rust Desktop Shell

```bash
npm run check:desktop-shell
npm run test:desktop-shell
npm run build:desktop-shell
```

### Native Bridge

```bash
npm run check:bridge-service-native
npm run test:bridge-service-native
npm run build:bridge-service-native
```

### Driver Development

Building the driver requires Visual Studio 2022 + WDK. Installing the development driver requires administrator privileges and TESTSIGNING mode.

```bash
npm run driver:build-sysvad
npm run driver:install
npm run driver:test
npm run driver:uninstall
```

## License

This project is licensed under the [Apache License 2.0](../LICENSE).
