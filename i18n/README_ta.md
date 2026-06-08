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
        <b>தமிழ்</b> |
        <a href="README_mr.md">मराठी</a> |
        <a href="README_th.md">ไทย</a> |
        <a href="README_fil.md">Filipino</a> |
        <a href="README_tr.md">Türkçe</a>
    </p>
</h4>

Omni Translate என்பது Windows க்கான real-time audio translation desktop app ஆகும். இது video subtitle translation, game voice translation, voice room அல்லது meeting க்கான bidirectional translation போன்ற workflow களை இலக்காகக் கொண்டது. App virtual audio driver, Native Bridge, Rust Core Runtime மற்றும் unified AI Gateway ஐ இணைத்து audio capture, ASR, LLM translation, TTS, subtitle rendering மற்றும் playback routing ஐ செயல்படுத்துகிறது.

## முக்கிய அம்சங்கள்

- **Real-time subtitle translation**: system audio அல்லது microphone audio ஐ capture செய்து, speech ஐ அடையாளம் கண்டு, main window மற்றும் overlay இல் translated subtitles ஐ காட்டுகிறது.
- **Floating subtitle overlay**: independent, transparent, borderless மற்றும் always-on-top window; video, game அல்லது meeting app களின் மேல் வைக்க வடிவமைக்கப்பட்டது.
- **Bidirectional voice translation**: watch, game மற்றும் voice room routing modes ஐ support செய்கிறது; inbound subtitles/translated audio மற்றும் outbound virtual microphone output ஐ கையாள்கிறது.
- **Virtual audio driver**: Windows SYSVAD WaveRT அடிப்படையிலான virtual audio driver, IOCTL மற்றும் shared ABI மூலம் user-mode bridge service உடன் இணைகிறது.
- **Rust Native Bridge**: `apps/bridge-service-native` தற்போது ஒரே production bridge implementation; இது WASAPI, Named Pipe IPC, audio frames மற்றும் driver communication ஐ கையாள்கிறது.
- **Unified AI Gateway**: template-driven DashScope மற்றும் OpenAI-compatible provider integration; HTTP, streaming HTTP மற்றும் WebSocket transports உடன்.
- **Glossary management**: domain glossary packages ஐ import, export, merge செய்து priority policy பயன்படுத்தி translation prompt flow இல் inject செய்கிறது.
- **Secure credential storage**: API Key மற்றும் பிற sensitive தகவல்கள் plaintext business configuration இல் எழுதப்படாமல் Windows Credential Manager இல் சேமிக்கப்படுகின்றன.
- **Diagnostics மற்றும் quality gates**: driver health probes, model Trace, log export, Watch Mode live-link tests மற்றும் release quality gates வழங்குகிறது.
- **20 UI languages**: தற்போதைய locale resources `ar`, `bn`, `de`, `en`, `es`, `fil`, `fr`, `hi`, `id`, `ja`, `ko`, `mr`, `pt`, `ru`, `ta`, `te`, `th`, `tr`, `vi`, மற்றும் `zh-CN` ஆகியவற்றை கவர் செய்கின்றன.

## விரைவு தொடக்கம்

### தேவைகள்

- **Node.js** >= 20
- **Rust stable**, edition 2021
- **Windows 10/11**
- **Visual Studio 2022 + WDK 10.0.26100**, virtual audio driver build செய்யும்போது மட்டுமே தேவை
- development driver load செய்ய Windows TESTSIGNING mode தேவை; சாதாரண frontend preview க்கு driver அல்லது administrator privileges தேவையில்லை

### நிறுவல் மற்றும் இயக்கம்

```bash
# 1. repository clone செய்யவும்
git clone <repo-url>
cd omni-translate

# 2. dependencies install செய்யவும்
npm install

# 3. frontend browser preview ஐ தொடங்கவும்
npm run dev:desktop

# 4. முழு Tauri desktop app ஐ தொடங்கவும்
npm run dev:desktop-shell
```

Browser preview mode தானாக Mock runtime ஐ பயன்படுத்துகிறது; எனவே UI development மற்றும் page checks க்கு இது பொருத்தமானது. முழு desktop app Tauri/Rust runtime ஐ தொடங்கும்; driver installation அல்லது repair action உள்ளபோது மட்டுமே elevation flow தொடங்கும்.

### பொதுவான கட்டளைகள்

| கட்டளை | விளக்கம் |
| --- | --- |
| `npm run dev:desktop` | React/Vite frontend dev server ஐ தொடங்கும் |
| `npm run dev:desktop-shell` | elevation script மூலம் முழு Tauri desktop app ஐ தொடங்கும் |
| `npm run lint:desktop` | desktop frontend க்கான ESLint ஐ இயக்கும் |
| `npm run check:desktop` | TypeScript type checking ஐ இயக்கும் |
| `npm run build:desktop` | frontend assets ஐ build செய்யும் |
| `npm run check:desktop-shell` | Tauri Rust backend ஐ check செய்யும் |
| `npm run build:desktop-shell` | முழு Tauri app ஐ build செய்யும் |
| `npm run build:bridge-service-native` | Rust Native Bridge Service ஐ build செய்யும் |
| `npm run test:all` | full test entrypoint ஐ இயக்கும் |
| `npm run test:contracts` | frozen contracts ஐ verify செய்யும் |
| `npm run test:watch-mode-live:dry-run` | Watch Mode live-link dry-run ஐ இயக்கும் |
| `npm run quality:gate:auto` | automated quality gate ஐ இயக்கும் |
| `npm run quality:gate:release` | release quality gate ஐ இயக்கும் |
| `npm run driver:build-sysvad` | SYSVAD virtual audio driver ஐ build செய்யும் |
| `npm run driver:install` | development driver ஐ install செய்யும் |
| `npm run driver:test` | development driver status ஐ probe செய்யும் |
| `npm run driver:uninstall` | development driver ஐ uninstall செய்யும் |
| `npm run release:prepare` | வெளியீட்டு தயாரிப்பு pipeline ஐ இயக்கும் |

## சிஸ்டம் கட்டமைப்பு

```text
┌────────────────────────────────────────────────────────────┐
│ 1. Desktop Shell                                            │
│    Tauri 2 + React 19 + TypeScript 6 + Vite 8/Rolldown      │
│    main window, subtitle overlay, routing, settings,        │
│    diagnostics, Provider pages                              │
├────────────────────────────────────────────────────────────┤
│ 2. Rust Core Runtime                                        │
│    Tauri commands/events, session orchestration, config     │
│    storage, diagnostics, tray integration                   │
├────────────────────────────────────────────────────────────┤
│ 3. Audio Layer                                              │
│    WASAPI + cpal + rodio, system/mic capture, VAD,           │
│    segmentation, mixing                                     │
├────────────────────────────────────────────────────────────┤
│ 4. AI Gateway                                               │
│    reqwest + tungstenite, ASR / Translation / TTS Provider   │
│    DashScope மற்றும் OpenAI-compatible templates, capability│
│    probes, error normalization                              │
├────────────────────────────────────────────────────────────┤
│ 5. Native Bridge Service                                    │
│    Rust sidecar, WASAPI, Named Pipe IPC, audio frames,       │
│    driver IOCTL                                             │
├────────────────────────────────────────────────────────────┤
│ 6. Driver / Installer                                       │
│    SYSVAD WaveRT virtual audio driver, install, rollback,    │
│    repair மற்றும் health probing                            │
└────────────────────────────────────────────────────────────┘
```

## அடைவுக் கட்டமைப்பு

```text
omni-translate/
├── apps/
│   ├── desktop/                    # Tauri desktop application
│   │   ├── src/                    # React frontend
│   │   │   ├── components/         # shared UI components
│   │   │   ├── i18n/               # 20 UI locale resources
│   │   │   ├── pages/              # session, routing, Provider, glossary, settings, diagnostics pages
│   │   │   ├── runtime/            # frontend runtime/IPC adapter layer
│   │   │   ├── schema/             # TypeScript contracts மற்றும் types
│   │   │   └── stores/             # Zustand state
│   │   └── src-tauri/              # Rust desktop shell
│   │       └── src/
│   │           ├── audio/          # audio engine, STT, TTS, translation routing, realtime Providers
│   │           ├── bridge/         # Bridge/driver installation மற்றும் IPC contracts
│   │           ├── diagnostics/    # logs, Trace, diagnostic state
│   │           ├── provider/       # AI Gateway, Provider templates, HTTP/WS transport
│   │           ├── runtime/        # windows, tray, runtime state
│   │           └── storage/        # SQLite repository மற்றும் credential handling
│   └── bridge-service-native/      # Rust Native Bridge Service, ஒரே production bridge implementation
├── drivers/
│   └── windows-virtual-mic/        # SYSVAD WaveRT virtual audio driver
│       ├── include/                # Driver/Bridge shared IOCTL ABI
│       ├── package/                # driver package metadata
│       └── sysvad/                 # Microsoft SYSVAD sample இலிருந்து modified driver source
├── scripts/
│   ├── development/                # development launch scripts
│   ├── diagnostics/                # diagnostic tools
│   ├── installer/                  # driver build, install, uninstall, repair, probe
│   ├── release/                    # release verification, manifest, packaging, signing manifest
│   └── testing/                    # tests, coverage, quality gates, Watch Mode links
├── docs/                           # architecture, quality, project docs மற்றும் Provider/API references
└── artifacts/                      # build outputs, logs மற்றும் diagnostic output
```

## முக்கிய ஓட்டங்கள்

### உள்ளே வரும் மொழிபெயர்ப்பு (பார்வை/வரிகள் சூழல்கள்)

```text
System audio
  → virtual audio driver / WASAPI capture
  → Native Bridge Service
  → Desktop Rust Audio Layer
  → VAD / segmentation
  → ASR
  → Translation Provider
  → subtitle rendering (main window + overlay)
  → optional TTS
  → local speaker / monitor output
```

### வெளியேறும் மொழிபெயர்ப்பு (குரல் அறை/கூட்டம்/விளையாட்டு சூழல்கள்)

```text
Microphone
  → Desktop Rust Audio Layer
  → VAD / segmentation
  → ASR
  → Translation Provider
  → TTS
  → Native Bridge Service
  → virtual audio driver
  → target app virtual microphone / virtual endpoint ஐ படிக்கிறது
```

### தாமதம் மற்றும் குறைக்கப்பட்ட முறை

- Subtitles மற்றும் dubbed speech தனித்தனி scheduling results; subtitles முதலில் commit செய்யப்படும்.
- Provider latency budget ஐ மீறினால் `latency-high` emit செய்யப்படும், subtitles தொடரும், TTS deferred/queued state க்கு செல்லும்.
- Provider probing ஒரு Provider real time பயன்பாட்டுக்கு பொருத்தமில்லை என குறித்தால், dubbed speech default ஆக முடக்கப்படும்; subtitle-first path செயலில் இருக்கும்.
- Driver அல்லது Bridge failure app startup ஐ block செய்யாது; subtitles, local playback மற்றும் diagnostics degraded mode இல் கிடைக்க வேண்டும்.

## தொழில்நுட்ப அடுக்கு

| அடுக்கு | தொழில்நுட்பம் |
| --- | --- |
| Frontend | React 19.2.x, TypeScript 6.0.x, Vite 8.x, Rolldown, CSS |
| Desktop shell | Tauri 2.x, `@tauri-apps/api`, `@tauri-apps/cli` |
| State மற்றும் routing | Zustand 5.x, react-router-dom 7.x |
| Internationalization | i18next 26.x, react-i18next 17.x, i18next-browser-languagedetector |
| Frontend testing | Vitest 4.x, jsdom 29.x, ESLint 10.x |
| Rust runtime | Rust 2021, Serde, Tauri commands/events |
| Provider networking | reqwest 0.13, tungstenite 0.29, rustls |
| Storage மற்றும் credentials | rusqlite 0.40 bundled SQLite, keyring 4, Windows Credential Manager |
| Audio | cpal 0.17, rodio 0.22, wasapi 0.23, hound, minimp3 |
| System APIs | windows-sys 0.61 |
| Native Bridge | Rust sidecar, WASAPI, Named Pipe, IOCTL ABI |
| Driver | Windows SYSVAD WaveRT virtual audio driver |
| Scripts | PowerShell, Node.js release/testing scripts |

## ஒப்பந்தங்கள் மற்றும் தரவு எல்லைகள்

Project தற்போது நான்கு frozen contract areas ஐ பராமரிக்கிறது:

1. **Provider Contract**: Provider metadata, auth references, request parameters, streaming events, error structures மற்றும் capability probe results.
2. **Audio Contract**: system audio, microphone, PCM frames, segments, mixing, latency compensation மற்றும் push-to-talk state.
3. **Driver Bridge Contract**: Desktop, Native Bridge மற்றும் driver இடையிலான initialization, audio frames, state queries, error events மற்றும் shutdown protocol.
4. **OBS Integration Contract**: எதிர்கால OBS subtitle overlay மற்றும் scene trigger support க்கான reserved connection மற்றும் output boundary.

Structured configuration முக்கிய truth source ஆக SQLite ஐ பயன்படுத்துகிறது. Sensitive credentials Windows Credential Manager இல் stored ஆகும். Logs, caches, glossary packages மற்றும் temporary audio files தனி directories இல் வைக்கப்படுகின்றன.

## தரம் மற்றும் சோதனை

- `npm run verify:desktop`: desktop frontend lint, typecheck, test மற்றும் build.
- `npm run test:desktop-shell`: Tauri Rust backend tests.
- `npm run test:bridge-service-native`: Native Bridge Rust tests.
- `npm run test:contracts`: TypeScript/Rust/script-side frozen contract verification.
- `npm run quality:gate:auto`: automated quality gate.
- `npm run quality:gate:release`: manual verification entrypoints உடன் release quality gate.
- `npm run test:watch-mode-report` / `npm run test:watch-mode-live:*`: Watch Mode reports, evidence மற்றும் live-link test entrypoints.

## மேம்பாடு

### முன்புற மேம்பாடு

Frontend ஐ browser இல் develop செய்ய `npm run dev:desktop` பயன்படுத்தவும். Non-Tauri environments இல் runtime layer Mock data ஐ வழங்கும்; அதனால் driver install செய்யாமல் அல்லது Rust backend தொடங்காமல் pages மற்றும் interactions ஐ check செய்யலாம்.

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

### டிரைவர் மேம்பாடு

Driver build செய்ய Visual Studio 2022 + WDK தேவை. Development driver install செய்ய administrator privileges மற்றும் TESTSIGNING mode தேவை.

```bash
npm run driver:build-sysvad
npm run driver:install
npm run driver:test
npm run driver:uninstall
```

## உரிமம்

இந்த project private license கீழ் வழங்கப்படுகிறது. அனைத்து உரிமைகளும் பாதுகாக்கப்பட்டவை.
