# Omni Translate

<h4 align="center">
    <p>
        <a href="../README.md">简体中文</a> |
        <a href="README_en.md">English</a> |
        <a href="README_es.md">Español</a> |
        <a href="README_ar.md">العربية</a> |
        <a href="README_pt.md">Português</a> |
        <a href="README_ru.md">Русский</a> |
        <b>हिन्दी</b> |
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

Omni Translate Windows के लिए रियल-टाइम ऑडियो अनुवाद वाला डेस्कटॉप ऐप है। यह वीडियो सबटाइटल अनुवाद, गेम वॉइस अनुवाद, और वॉइस रूम या मीटिंग के द्विदिश अनुवाद जैसे workflow को लक्षित करता है। ऐप virtual audio driver, Native Bridge, Rust Core Runtime और unified AI Gateway को जोड़कर audio capture, ASR, LLM translation, TTS, subtitle rendering और playback routing को संभालता है।

## मुख्य विशेषताएं

- **रियल-टाइम सबटाइटल अनुवाद**: सिस्टम ऑडियो या माइक्रोफोन ऑडियो कैप्चर करता है, speech पहचानता है, और मुख्य विंडो व overlay में अनूदित सबटाइटल दिखाता है।
- **फ्लोटिंग सबटाइटल overlay**: स्वतंत्र, पारदर्शी, borderless और always-on-top विंडो, जिसे वीडियो, गेम या मीटिंग ऐप्स के ऊपर रखा जा सकता है।
- **द्विदिश वॉइस अनुवाद**: watch, game और voice room routing mode का समर्थन करता है, जिसमें inbound subtitles/translated audio और outbound virtual microphone output शामिल हैं।
- **वर्चुअल ऑडियो ड्राइवर**: Windows SYSVAD WaveRT-आधारित virtual audio driver, जो IOCTL और shared ABI के माध्यम से user-mode bridge service से जुड़ता है।
- **Rust Native Bridge**: `apps/bridge-service-native` वर्तमान में एकमात्र production bridge implementation है, जो WASAPI, Named Pipe IPC, audio frames और driver communication संभालता है।
- **Unified AI Gateway**: template-driven DashScope और OpenAI-compatible provider integration, HTTP, streaming HTTP और WebSocket transports के समर्थन के साथ।
- **Glossary management**: domain glossary packages को import, export, merge और prioritize करता है, फिर उन्हें translation prompt flow में inject करता है।
- **सुरक्षित credential storage**: API Key और अन्य sensitive जानकारी plaintext business configuration में लिखने के बजाय Windows Credential Manager में रखी जाती है।
- **Diagnostics और quality gates**: driver health probes, model Trace, log export, Watch Mode live-link tests और release quality gates प्रदान करता है।
- **20 UI भाषाएं**: मौजूदा locale resources `ar`, `bn`, `de`, `en`, `es`, `fil`, `fr`, `hi`, `id`, `ja`, `ko`, `mr`, `pt`, `ru`, `ta`, `te`, `th`, `tr`, `vi`, और `zh-CN` को कवर करते हैं।

## त्वरित शुरुआत

### आवश्यकताएं

- **Node.js** >= 20
- **Rust stable**, edition 2021
- **Windows 10/11**
- **Visual Studio 2022 + WDK 10.0.26100**, केवल virtual audio driver build करते समय आवश्यक
- development driver load करने के लिए Windows TESTSIGNING mode चाहिए; सामान्य frontend preview के लिए driver या administrator privilege की आवश्यकता नहीं होती

### इंस्टॉल और रन

```bash
# 1. रिपॉजिटरी clone करें
git clone <repo-url>
cd omni-translate

# 2. dependencies install करें
npm install

# 3. frontend browser preview शुरू करें
npm run dev:desktop

# 4. पूरा Tauri desktop app शुरू करें
npm run dev:desktop-shell
```

Browser preview mode अपने-आप Mock runtime का उपयोग करता है, इसलिए यह UI development और page checks के लिए उपयुक्त है। पूरा desktop app Tauri/Rust runtime शुरू करता है और driver installation या repair action होने पर ही elevation flow चलाता है।

### सामान्य कमांड

| कमांड | विवरण |
| --- | --- |
| `npm run dev:desktop` | React/Vite frontend dev server शुरू करता है |
| `npm run dev:desktop-shell` | elevation script के माध्यम से पूरा Tauri desktop app शुरू करता है |
| `npm run lint:desktop` | desktop frontend के लिए ESLint चलाता है |
| `npm run check:desktop` | TypeScript type checking चलाता है |
| `npm run build:desktop` | frontend assets build करता है |
| `npm run check:desktop-shell` | Tauri Rust backend check करता है |
| `npm run build:desktop-shell` | पूरा Tauri app build करता है |
| `npm run build:bridge-service-native` | Rust Native Bridge Service build करता है |
| `npm run test:all` | full test entrypoint चलाता है |
| `npm run test:contracts` | frozen contracts verify करता है |
| `npm run test:watch-mode-live:dry-run` | Watch Mode live-link dry-run चलाता है |
| `npm run quality:gate:auto` | automated quality gate चलाता है |
| `npm run quality:gate:release` | release quality gate चलाता है |
| `npm run driver:build-sysvad` | SYSVAD virtual audio driver build करता है |
| `npm run driver:install` | development driver install करता है |
| `npm run driver:test` | development driver status probe करता है |
| `npm run driver:uninstall` | development driver uninstall करता है |
| `npm run release:prepare` | रिलीज़ तैयारी पाइपलाइन चलाता है |

## सिस्टम आर्किटेक्चर

```text
┌────────────────────────────────────────────────────────────┐
│ 1. Desktop Shell                                            │
│    Tauri 2 + React 19 + TypeScript 6 + Vite 8/Rolldown      │
│    मुख्य विंडो, subtitle overlay, routing, settings,        │
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
│    DashScope और OpenAI-compatible templates, capability     │
│    probes, error normalization                              │
├────────────────────────────────────────────────────────────┤
│ 5. Native Bridge Service                                    │
│    Rust sidecar, WASAPI, Named Pipe IPC, audio frames,       │
│    driver IOCTL                                             │
├────────────────────────────────────────────────────────────┤
│ 6. Driver / Installer                                       │
│    SYSVAD WaveRT virtual audio driver, install, rollback,    │
│    repair और health probing                                 │
└────────────────────────────────────────────────────────────┘
```

## डायरेक्टरी संरचना

```text
omni-translate/
├── apps/
│   ├── desktop/                    # Tauri desktop application
│   │   ├── src/                    # React frontend
│   │   │   ├── components/         # shared UI components
│   │   │   ├── i18n/               # 20 UI locale resources
│   │   │   ├── pages/              # session, routing, Provider, glossary, settings, diagnostics pages
│   │   │   ├── runtime/            # frontend runtime/IPC adapter layer
│   │   │   ├── schema/             # TypeScript contracts और types
│   │   │   └── stores/             # Zustand state
│   │   └── src-tauri/              # Rust desktop shell
│   │       └── src/
│   │           ├── audio/          # audio engine, STT, TTS, translation routing, realtime Providers
│   │           ├── bridge/         # Bridge/driver installation और IPC contracts
│   │           ├── diagnostics/    # logs, Trace, diagnostic state
│   │           ├── provider/       # AI Gateway, Provider templates, HTTP/WS transport
│   │           ├── runtime/        # windows, tray, runtime state
│   │           └── storage/        # SQLite repository और credential handling
│   └── bridge-service-native/      # Rust Native Bridge Service, एकमात्र production bridge implementation
├── drivers/
│   └── windows-virtual-mic/        # SYSVAD WaveRT virtual audio driver
│       ├── include/                # Driver/Bridge shared IOCTL ABI
│       ├── package/                # driver package metadata
│       └── sysvad/                 # Microsoft SYSVAD sample से modified driver source
├── scripts/
│   ├── development/                # development launch scripts
│   ├── diagnostics/                # diagnostic tools
│   ├── installer/                  # driver build, install, uninstall, repair, probe
│   ├── release/                    # release verification, manifest, packaging, signing manifest
│   └── testing/                    # tests, coverage, quality gates, Watch Mode links
├── docs/                           # architecture, quality, project docs और Provider/API references
└── artifacts/                      # build outputs, logs और diagnostic output
```

## मुख्य फ्लो

### इनबाउंड अनुवाद (देखने/सबटाइटल परिदृश्य)

```text
सिस्टम ऑडियो
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

### आउटबाउंड अनुवाद (वॉइस रूम/मीटिंग/गेम परिदृश्य)

```text
माइक्रोफोन
  → Desktop Rust Audio Layer
  → VAD / segmentation
  → ASR
  → Translation Provider
  → TTS
  → Native Bridge Service
  → virtual audio driver
  → target app virtual microphone / virtual endpoint पढ़ता है
```

### विलंबता और अवनत मोड

- सबटाइटल और dubbed speech अलग-अलग scheduling result हैं; सबटाइटल पहले commit किए जाते हैं।
- Provider latency budget से अधिक होने पर `latency-high` emit होता है, subtitles जारी रहते हैं, और TTS deferred/queued state में जाता है।
- Provider probing अगर किसी Provider को real time उपयोग के लिए अनुपयुक्त बताती है, तो dubbed speech default रूप से बंद रहता है और subtitle-first path सक्रिय रहता है।
- Driver या Bridge failure app startup को block नहीं करते; subtitles, local playback और diagnostics degraded mode में उपलब्ध रहने चाहिए।

## टेक स्टैक

| स्तर | तकनीक |
| --- | --- |
| Frontend | React 19.2.x, TypeScript 6.0.x, Vite 8.x, Rolldown, CSS |
| Desktop shell | Tauri 2.x, `@tauri-apps/api`, `@tauri-apps/cli` |
| State और routing | Zustand 5.x, react-router-dom 7.x |
| Internationalization | i18next 26.x, react-i18next 17.x, i18next-browser-languagedetector |
| Frontend testing | Vitest 4.x, jsdom 29.x, ESLint 10.x |
| Rust runtime | Rust 2021, Serde, Tauri commands/events |
| Provider networking | reqwest 0.13, tungstenite 0.29, rustls |
| Storage और credentials | rusqlite 0.40 bundled SQLite, keyring 4, Windows Credential Manager |
| Audio | cpal 0.17, rodio 0.22, wasapi 0.23, hound, minimp3 |
| System APIs | windows-sys 0.61 |
| Native Bridge | Rust sidecar, WASAPI, Named Pipe, IOCTL ABI |
| Driver | Windows SYSVAD WaveRT virtual audio driver |
| Scripts | PowerShell, Node.js release/testing scripts |

## कॉन्ट्रैक्ट और डेटा सीमाएं

प्रोजेक्ट अभी चार frozen contract areas को maintain करता है:

1. **Provider Contract**: Provider metadata, auth references, request parameters, streaming events, error structures और capability probe results।
2. **Audio Contract**: system audio, microphone, PCM frames, segments, mixing, latency compensation और push-to-talk state।
3. **Driver Bridge Contract**: Desktop, Native Bridge और driver के बीच initialization, audio frames, state queries, error events और shutdown protocol।
4. **OBS Integration Contract**: भविष्य के OBS subtitle overlay और scene trigger support के लिए reserved connection और output boundary।

Structured configuration मुख्य सत्य स्रोत के रूप में SQLite का उपयोग करता है। Sensitive credentials Windows Credential Manager में stored हैं। Logs, caches, glossary packages और temporary audio files अलग directories में रखे जाते हैं।

## गुणवत्ता और टेस्ट

- `npm run verify:desktop`: desktop frontend lint, typecheck, test और build।
- `npm run test:desktop-shell`: Tauri Rust backend tests।
- `npm run test:bridge-service-native`: Native Bridge Rust tests।
- `npm run test:contracts`: TypeScript/Rust/script side frozen contract verification।
- `npm run quality:gate:auto`: automated quality gate।
- `npm run quality:gate:release`: manual verification entrypoints वाला release quality gate।
- `npm run test:watch-mode-report` / `npm run test:watch-mode-live:*`: Watch Mode reports, evidence और live-link test entrypoints।

## डेवलपमेंट

### फ्रंटएंड विकास

Frontend को browser में develop करने के लिए `npm run dev:desktop` उपयोग करें। Non-Tauri environments में runtime layer Mock data लौटाती है, जिससे driver install किए बिना या Rust backend start किए बिना pages और interactions check किए जा सकते हैं।

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

### ड्राइवर विकास

Driver build करने के लिए Visual Studio 2022 + WDK आवश्यक है। Development driver install करने के लिए administrator privileges और TESTSIGNING mode चाहिए।

```bash
npm run driver:build-sysvad
npm run driver:install
npm run driver:test
npm run driver:uninstall
```

## लाइसेंस

यह प्रोजेक्ट private license के अंतर्गत है। सभी अधिकार सुरक्षित हैं।
