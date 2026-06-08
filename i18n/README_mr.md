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
        <b>मराठी</b> |
        <a href="README_th.md">ไทย</a> |
        <a href="README_fil.md">Filipino</a> |
        <a href="README_tr.md">Türkçe</a>
    </p>
</h4>

Omni Translate हे Windows साठी real-time audio translation करणारे desktop app आहे. ते video subtitle translation, game voice translation आणि voice room किंवा meeting मधील bidirectional translation अशा workflow साठी तयार आहे. App virtual audio driver, Native Bridge, Rust Core Runtime आणि unified AI Gateway जोडून audio capture, ASR, LLM translation, TTS, subtitle rendering आणि playback routing हाताळते.

## मुख्य वैशिष्ट्ये

- **Real-time subtitle translation**: system audio किंवा microphone audio capture करून speech ओळखते आणि मुख्य window व overlay मध्ये translated subtitles दाखवते.
- **Floating subtitle overlay**: independent, transparent, borderless आणि always-on-top window, जी video, game किंवा meeting app वर ठेवता येते.
- **Bidirectional voice translation**: watch, game आणि voice room routing modes support करते; inbound subtitles/translated audio आणि outbound virtual microphone output कव्हर करते.
- **Virtual audio driver**: Windows SYSVAD WaveRT-आधारित virtual audio driver, जो IOCTL आणि shared ABI द्वारे user-mode bridge service शी जोडला जातो.
- **Rust Native Bridge**: `apps/bridge-service-native` सध्या एकमेव production bridge implementation आहे; ते WASAPI, Named Pipe IPC, audio frames आणि driver communication हाताळते.
- **Unified AI Gateway**: template-driven DashScope आणि OpenAI-compatible provider integration, HTTP, streaming HTTP आणि WebSocket transports सह.
- **Glossary management**: domain glossary packages import, export, merge आणि priority policy support करते व त्यांना translation prompt flow मध्ये inject करते.
- **Secure credential storage**: API Key आणि इतर sensitive माहिती plaintext business configuration मध्ये न ठेवता Windows Credential Manager मध्ये साठवली जाते.
- **Diagnostics आणि quality gates**: driver health probes, model Trace, log export, Watch Mode live-link tests आणि release quality gates उपलब्ध करतात.
- **20 UI languages**: सध्याची locale resources `ar`, `bn`, `de`, `en`, `es`, `fil`, `fr`, `hi`, `id`, `ja`, `ko`, `mr`, `pt`, `ru`, `ta`, `te`, `th`, `tr`, `vi` आणि `zh-CN` कव्हर करतात.

## त्वरित सुरुवात

### आवश्यकता

- **Node.js** >= 20
- **Rust stable**, edition 2021
- **Windows 10/11**
- **Visual Studio 2022 + WDK 10.0.26100**, फक्त virtual audio driver build करताना आवश्यक
- development driver load करण्यासाठी Windows TESTSIGNING mode आवश्यक आहे; सामान्य frontend preview साठी driver किंवा administrator privileges लागत नाहीत

### इंस्टॉल आणि चालवा

```bash
# 1. repository clone करा
git clone <repo-url>
cd omni-translate

# 2. dependencies install करा
npm install

# 3. frontend browser preview सुरू करा
npm run dev:desktop

# 4. पूर्ण Tauri desktop app सुरू करा
npm run dev:desktop-shell
```

Browser preview mode आपोआप Mock runtime वापरतो, त्यामुळे UI development आणि page checks साठी तो योग्य आहे. पूर्ण desktop app Tauri/Rust runtime सुरू करते आणि driver installation किंवा repair action असतील तेव्हाच elevation flow चालवते.

### सामान्य कमांड

| कमांड | वर्णन |
| --- | --- |
| `npm run dev:desktop` | React/Vite frontend dev server सुरू करते |
| `npm run dev:desktop-shell` | elevation script द्वारे पूर्ण Tauri desktop app सुरू करते |
| `npm run lint:desktop` | desktop frontend साठी ESLint चालवते |
| `npm run check:desktop` | TypeScript type checking चालवते |
| `npm run build:desktop` | frontend assets build करते |
| `npm run check:desktop-shell` | Tauri Rust backend check करते |
| `npm run build:desktop-shell` | पूर्ण Tauri app build करते |
| `npm run build:bridge-service-native` | Rust Native Bridge Service build करते |
| `npm run test:all` | full test entrypoint चालवते |
| `npm run test:contracts` | frozen contracts verify करते |
| `npm run test:watch-mode-live:dry-run` | Watch Mode live-link dry-run चालवते |
| `npm run quality:gate:auto` | automated quality gate चालवते |
| `npm run quality:gate:release` | release quality gate चालवते |
| `npm run driver:build-sysvad` | SYSVAD virtual audio driver build करते |
| `npm run driver:install` | development driver install करते |
| `npm run driver:test` | development driver status probe करते |
| `npm run driver:uninstall` | development driver uninstall करते |
| `npm run release:prepare` | रिलीज तयारी पाइपलाइन चालवते |

## सिस्टम आर्किटेक्चर

```text
┌────────────────────────────────────────────────────────────┐
│ 1. Desktop Shell                                            │
│    Tauri 2 + React 19 + TypeScript 6 + Vite 8/Rolldown      │
│    मुख्य window, subtitle overlay, routing, settings,       │
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
│    DashScope आणि OpenAI-compatible templates, capability    │
│    probes, error normalization                              │
├────────────────────────────────────────────────────────────┤
│ 5. Native Bridge Service                                    │
│    Rust sidecar, WASAPI, Named Pipe IPC, audio frames,       │
│    driver IOCTL                                             │
├────────────────────────────────────────────────────────────┤
│ 6. Driver / Installer                                       │
│    SYSVAD WaveRT virtual audio driver, install, rollback,    │
│    repair आणि health probing                                │
└────────────────────────────────────────────────────────────┘
```

## डिरेक्टरी रचना

```text
omni-translate/
├── apps/
│   ├── desktop/                    # Tauri desktop application
│   │   ├── src/                    # React frontend
│   │   │   ├── components/         # shared UI components
│   │   │   ├── i18n/               # 20 UI locale resources
│   │   │   ├── pages/              # session, routing, Provider, glossary, settings, diagnostics pages
│   │   │   ├── runtime/            # frontend runtime/IPC adapter layer
│   │   │   ├── schema/             # TypeScript contracts आणि types
│   │   │   └── stores/             # Zustand state
│   │   └── src-tauri/              # Rust desktop shell
│   │       └── src/
│   │           ├── audio/          # audio engine, STT, TTS, translation routing, realtime Providers
│   │           ├── bridge/         # Bridge/driver installation आणि IPC contracts
│   │           ├── diagnostics/    # logs, Trace, diagnostic state
│   │           ├── provider/       # AI Gateway, Provider templates, HTTP/WS transport
│   │           ├── runtime/        # windows, tray, runtime state
│   │           └── storage/        # SQLite repository आणि credential handling
│   └── bridge-service-native/      # Rust Native Bridge Service, एकमेव production bridge implementation
├── drivers/
│   └── windows-virtual-mic/        # SYSVAD WaveRT virtual audio driver
│       ├── include/                # Driver/Bridge shared IOCTL ABI
│       ├── package/                # driver package metadata
│       └── sysvad/                 # Microsoft SYSVAD sample वरून modified driver source
├── scripts/
│   ├── development/                # development launch scripts
│   ├── diagnostics/                # diagnostic tools
│   ├── installer/                  # driver build, install, uninstall, repair, probe
│   ├── release/                    # release verification, manifest, packaging, signing manifest
│   └── testing/                    # tests, coverage, quality gates, Watch Mode links
├── docs/                           # architecture, quality, project docs आणि Provider/API references
└── artifacts/                      # build outputs, logs आणि diagnostic output
```

## मुख्य फ्लो

### इनबाउंड अनुवाद (पाहणे/सबटायटल परिस्थिती)

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

### आउटबाउंड अनुवाद (व्हॉइस रूम/मीटिंग/गेम परिस्थिती)

```text
Microphone
  → Desktop Rust Audio Layer
  → VAD / segmentation
  → ASR
  → Translation Provider
  → TTS
  → Native Bridge Service
  → virtual audio driver
  → target app virtual microphone / virtual endpoint वाचते
```

### विलंबता आणि अवनत मोड

- Subtitles आणि dubbed speech वेगवेगळे scheduling results आहेत; subtitles आधी commit होतात.
- Provider latency budget पेक्षा जास्त झाल्यास `latency-high` emit होते, subtitles सुरू राहतात आणि TTS deferred/queued state मध्ये जाते.
- Provider probing एखाद्या Provider ला real time वापरासाठी अयोग्य ठरवल्यास dubbed speech default ने बंद राहते आणि subtitle-first path सक्रिय राहतो.
- Driver किंवा Bridge failure app startup block करत नाहीत; subtitles, local playback आणि diagnostics degraded mode मध्ये उपलब्ध राहावेत.

## टेक स्टॅक

| स्तर | तंत्रज्ञान |
| --- | --- |
| Frontend | React 19.2.x, TypeScript 6.0.x, Vite 8.x, Rolldown, CSS |
| Desktop shell | Tauri 2.x, `@tauri-apps/api`, `@tauri-apps/cli` |
| State आणि routing | Zustand 5.x, react-router-dom 7.x |
| Internationalization | i18next 26.x, react-i18next 17.x, i18next-browser-languagedetector |
| Frontend testing | Vitest 4.x, jsdom 29.x, ESLint 10.x |
| Rust runtime | Rust 2021, Serde, Tauri commands/events |
| Provider networking | reqwest 0.13, tungstenite 0.29, rustls |
| Storage आणि credentials | rusqlite 0.40 bundled SQLite, keyring 4, Windows Credential Manager |
| Audio | cpal 0.17, rodio 0.22, wasapi 0.23, hound, minimp3 |
| System APIs | windows-sys 0.61 |
| Native Bridge | Rust sidecar, WASAPI, Named Pipe, IOCTL ABI |
| Driver | Windows SYSVAD WaveRT virtual audio driver |
| Scripts | PowerShell, Node.js release/testing scripts |

## करार आणि डेटा सीमा

प्रकल्प सध्या चार frozen contract areas maintain करतो:

1. **Provider Contract**: Provider metadata, auth references, request parameters, streaming events, error structures आणि capability probe results.
2. **Audio Contract**: system audio, microphone, PCM frames, segments, mixing, latency compensation आणि push-to-talk state.
3. **Driver Bridge Contract**: Desktop, Native Bridge आणि driver मधील initialization, audio frames, state queries, error events आणि shutdown protocol.
4. **OBS Integration Contract**: भविष्यातील OBS subtitle overlay आणि scene trigger support साठी reserved connection आणि output boundary.

Structured configuration मुख्य सत्य स्रोत म्हणून SQLite वापरते. Sensitive credentials Windows Credential Manager मध्ये stored असतात. Logs, caches, glossary packages आणि temporary audio files स्वतंत्र directories मध्ये ठेवले जातात.

## गुणवत्ता आणि चाचणी

- `npm run verify:desktop`: desktop frontend lint, typecheck, test आणि build.
- `npm run test:desktop-shell`: Tauri Rust backend tests.
- `npm run test:bridge-service-native`: Native Bridge Rust tests.
- `npm run test:contracts`: TypeScript/Rust/script-side frozen contract verification.
- `npm run quality:gate:auto`: automated quality gate.
- `npm run quality:gate:release`: manual verification entrypoints सह release quality gate.
- `npm run test:watch-mode-report` / `npm run test:watch-mode-live:*`: Watch Mode reports, evidence आणि live-link test entrypoints.

## विकास

### फ्रंटएंड विकास

Frontend browser मध्ये develop करण्यासाठी `npm run dev:desktop` वापरा. Non-Tauri environments मध्ये runtime layer Mock data परत करते, त्यामुळे driver install न करता किंवा Rust backend सुरू न करता pages आणि interactions तपासता येतात.

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

### ड्रायव्हर विकास

Driver build करण्यासाठी Visual Studio 2022 + WDK आवश्यक आहे. Development driver install करण्यासाठी administrator privileges आणि TESTSIGNING mode आवश्यक आहे.

```bash
npm run driver:build-sysvad
npm run driver:install
npm run driver:test
npm run driver:uninstall
```

## परवाना

हा project private license अंतर्गत आहे. सर्व हक्क राखीव.
