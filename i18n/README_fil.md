# Omni Translate

<h4 align="center">
    <p>
        <a href="../README.md">简体中文</a> |
        <a href="README_en.md">English</a> |
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
        <b>Filipino</b> |
        <a href="README_tr.md">Türkçe</a>
    </p>
</h4>

Ang Omni Translate ay Windows desktop application para sa real-time na pagsasalin ng audio. Nakatuon ito sa mga workflow gaya ng pagsasalin ng subtitle sa video, pagsasalin ng boses sa laro, at bidirectional na pagsasalin para sa voice room o meeting. Pinagdurugtong ng app ang virtual audio driver, Native Bridge, Rust core runtime, at unified AI gateway upang iproseso ang audio capture, ASR, LLM translation, TTS, subtitle rendering, at playback routing.

## Mga Tampok

- **Real-time na pagsasalin ng subtitle**: Kinukuha ang system o microphone audio, kinikilala ang pananalita, at ipinapakita ang isinaling subtitle sa main window at overlay.
- **Lumulutang na subtitle overlay**: Isang transparent, frameless, always-on-top na window na idinisenyong ilagay sa ibabaw ng mga video, laro, o meeting app.
- **Bidirectional na pagsasalin ng boses**: Sumusuporta sa watch, game, at voice room routing modes para sa inbound subtitles/speech at outbound virtual microphone output.
- **Virtual audio driver**: Windows virtual audio driver na batay sa SYSVAD WaveRT at nakakonekta sa user mode sa pamamagitan ng IOCTL at shared ABI.
- **Rust Native Bridge**: Ang `apps/bridge-service-native` ang tanging production bridge implementation, na humahawak ng WASAPI, Named Pipe IPC, audio frames, at driver communication.
- **Unified AI Gateway**: Template-driven na pagsasama sa DashScope at OpenAI-compatible providers na may HTTP, streaming HTTP, at WebSocket transports.
- **Pamamahala ng glossary**: Nag-i-import, nag-e-export, nagme-merge, at nagtatakda ng priority sa mga domain glossary package, pagkatapos ay ini-inject ang mga ito sa translation prompt flow.
- **Ligtas na imbakan ng credentials**: Ang mga API key at iba pang secret ay iniimbak sa Windows Credential Manager sa halip na plaintext business configuration.
- **Diagnostics at quality gates**: Driver health probes, model traces, log export, Watch Mode live-link tests, at release quality gates.
- **20 UI language**: Sakop ng kasalukuyang locale resources ang `ar`, `bn`, `de`, `en`, `es`, `fil`, `fr`, `hi`, `id`, `ja`, `ko`, `mr`, `pt`, `ru`, `ta`, `te`, `th`, `tr`, `vi`, at `zh-CN`.

## Mabilis na Pagsisimula

### Mga Kinakailangan

- **Node.js** >= 20
- **Rust stable**, edition 2021
- **Windows 10/11**
- **Visual Studio 2022 + WDK 10.0.26100**, kailangan lamang kapag binubuo ang virtual audio driver
- Ang pag-load ng development drivers ay nangangailangan ng Windows TESTSIGNING mode; hindi kailangan ng normal frontend preview ang driver o administrator privileges

### Pag-install at Pagpapatakbo

```bash
# 1. Clone the repository
git clone <repo-url>
cd omni-translate

# 2. Install dependencies
npm install

# 3. Start the frontend browser preview
npm run dev:desktop

# 4. Start the full Tauri desktop app
npm run dev:desktop-shell
```

Awtomatikong gumagamit ang browser preview mode ng mock runtime, kaya angkop ito para sa UI development at page checks. Sinisimulan ng full desktop app ang Tauri/Rust runtime at nagti-trigger lamang ng elevation kapag may kinalaman sa driver installation o repair actions.

### Mga Karaniwang Utos

| Command | Paglalarawan |
| --- | --- |
| `npm run dev:desktop` | Simulan ang React/Vite frontend dev server |
| `npm run dev:desktop-shell` | Simulan ang full Tauri desktop app sa pamamagitan ng elevation script |
| `npm run lint:desktop` | Patakbuhin ang ESLint para sa desktop frontend |
| `npm run check:desktop` | Patakbuhin ang TypeScript type checking |
| `npm run build:desktop` | Buuin ang frontend assets |
| `npm run check:desktop-shell` | Suriin ang Tauri Rust backend |
| `npm run build:desktop-shell` | Buuin ang full Tauri app |
| `npm run build:bridge-service-native` | Buuin ang Rust Native Bridge Service |
| `npm run test:all` | Patakbuhin ang full test entrypoint |
| `npm run test:contracts` | I-verify ang frozen contracts |
| `npm run test:watch-mode-live:dry-run` | Patakbuhin ang Watch Mode live-link dry-run |
| `npm run quality:gate:auto` | Patakbuhin ang automated quality gate |
| `npm run quality:gate:release` | Patakbuhin ang release quality gate |
| `npm run driver:build-sysvad` | Buuin ang SYSVAD virtual audio driver |
| `npm run driver:install` | I-install ang development driver |
| `npm run driver:test` | I-probe ang development driver status |
| `npm run driver:uninstall` | I-uninstall ang development driver |
| `npm run release:prepare` | Patakbuhin ang pipeline ng paghahanda ng release |

## Arkitektura

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

## Istruktura ng Directory

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

## Mga Pangunahing Daloy

### Papasok na Pagsasalin (Mga Scenario ng Watch / Subtitle)

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

### Palabas na Pagsasalin (Mga Scenario ng Voice Room / Meeting / Game)

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

### Pagkaantala at Mga Degraded Mode

- Magkahiwalay na scheduling results ang subtitles at dubbed speech; unang kino-commit ang subtitles.
- Kapag lumampas sa budget ang provider latency, ine-emit ang `latency-high`, nagpapatuloy ang subtitles, at lumilipat ang TTS sa deferred/queued state.
- Kapag minarkahan ng provider probing na hindi angkop sa real time ang provider, naka-disable bilang default ang dubbed speech at nananatiling aktibo ang subtitle-first path.
- Hindi hinaharangan ng Driver o Bridge failures ang app startup; dapat manatiling available sa degraded mode ang subtitles, local playback, at diagnostics.

## Teknolohiyang Stack

| Layer | Teknolohiya |
| --- | --- |
| Frontend | React 19.2.x, TypeScript 6.0.x, Vite 8.x, Rolldown, CSS |
| Desktop shell | Tauri 2.x, `@tauri-apps/api`, `@tauri-apps/cli` |
| State at routing | Zustand 5.x, react-router-dom 7.x |
| Internationalization | i18next 26.x, react-i18next 17.x, i18next-browser-languagedetector |
| Frontend testing | Vitest 4.x, jsdom 29.x, ESLint 10.x |
| Rust runtime | Rust 2021, Serde, Tauri commands/events |
| Provider networking | reqwest 0.13, tungstenite 0.29, rustls |
| Storage at credentials | rusqlite 0.40 bundled SQLite, keyring 4, Windows Credential Manager |
| Audio | cpal 0.17, rodio 0.22, wasapi 0.23, hound, minimp3 |
| System APIs | windows-sys 0.61 |
| Native Bridge | Rust sidecar, WASAPI, Named Pipe, IOCTL ABI |
| Driver | Windows SYSVAD WaveRT virtual audio driver |
| Scripts | PowerShell, Node.js release/testing scripts |

## Mga Kontrata at Hangganan ng Data

Kasalukuyang pinapanatili ng proyekto ang apat na frozen contract areas:

1. **Provider Contract**: Provider metadata, auth references, request parameters, streaming events, error structures, at probe results.
2. **Audio Contract**: System audio, microphone, PCM frames, segments, mixing, latency compensation, at push-to-talk state.
3. **Driver Bridge Contract**: Initialization, audio frames, state queries, error events, at shutdown protocol sa pagitan ng Desktop, Native Bridge, at driver.
4. **OBS Integration Contract**: Nakalaang connection at output boundary para sa susunod na OBS subtitle overlay at scene trigger support.

Gumagamit ang structured configuration ng SQLite bilang main source of truth. Iniimbak ang sensitive credentials sa Windows Credential Manager. Pinaghihiwalay sa sariling directories ang logs, caches, glossary packages, at temporary audio files.

## Kalidad at Pagsubok

- `npm run verify:desktop`: desktop frontend lint, typecheck, test, at build.
- `npm run test:desktop-shell`: Tauri Rust backend tests.
- `npm run test:bridge-service-native`: Native Bridge Rust tests.
- `npm run test:contracts`: TypeScript/Rust/script frozen contract verification.
- `npm run quality:gate:auto`: automated quality gate.
- `npm run quality:gate:release`: release quality gate na may manual verification entrypoints.
- `npm run test:watch-mode-report` / `npm run test:watch-mode-live:*`: Watch Mode reports, evidence, at live-link test entrypoints.

## Pagpapaunlad

### Pagpapaunlad ng Frontend

Gamitin ang `npm run dev:desktop` upang mag-develop ng frontend sa browser. Sa mga non-Tauri environment, nagbabalik ang runtime layer ng mock data upang masuri ang pages at interactions nang hindi nag-i-install ng driver o nagsisimula ng Rust backend.

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

### Pagpapaunlad ng Driver

Kailangan ng Visual Studio 2022 + WDK para buuin ang driver. Kailangan ng administrator privileges at TESTSIGNING mode para i-install ang development driver.

```bash
npm run driver:build-sysvad
npm run driver:install
npm run driver:test
npm run driver:uninstall
```

## Lisensya

Ang proyektong ito ay may private license. Nakalaan ang lahat ng karapatan.
