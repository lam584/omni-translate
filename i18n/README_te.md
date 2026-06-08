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
        <b>తెలుగు</b> |
        <a href="README_ta.md">தமிழ்</a> |
        <a href="README_mr.md">मराठी</a> |
        <a href="README_th.md">ไทย</a> |
        <a href="README_fil.md">Filipino</a> |
        <a href="README_tr.md">Türkçe</a>
    </p>
</h4>

Omni Translate అనేది Windows లో real-time audio translation సందర్భాల కోసం రూపొందించిన desktop app. ఇది video subtitle translation, game voice translation, voice room/meeting bidirectional translation వంటి workflows ను కవర్ చేస్తుంది. App virtual audio driver, Native Bridge, Rust Core మరియు unified AI Gateway ను కలిపి system audio capture, speech recognition, LLM translation, speech synthesis, subtitle rendering మరియు audio playback ను అనుసంధానిస్తుంది.

## ముఖ్యమైన ఫీచర్లు

- **Real-time subtitle translation**: system audio లేదా microphone audio ను capture చేసి, real time లో గుర్తించి translated subtitles చూపిస్తుంది; main window మరియు floating window display కు support ఇస్తుంది.
- **Subtitle floating window**: స్వతంత్ర transparent, borderless, always-on-top window; videos, games లేదా meeting software పై ఉంచుకోవచ్చు.
- **Bidirectional voice translation**: watch, game, voice room వంటి routing modes కు support ఇస్తుంది; inbound subtitles/translated speech మరియు outbound virtual microphone output ను కవర్ చేస్తుంది.
- **Virtual audio driver**: SYSVAD WaveRT ఆధారిత Windows virtual audio driver; IOCTL/shared ABI ద్వారా user-mode bridge service తో communicate చేస్తుంది.
- **Rust Native Bridge**: `apps/bridge-service-native` ప్రస్తుతం ఏకైక production bridge implementation; WASAPI, Named Pipe IPC, audio frames మరియు driver interaction నిర్వహిస్తుంది.
- **Unified AI Gateway**: template-based DashScope మరియు OpenAI-compatible interfaces ను కలిపి HTTP, streaming HTTP, WebSocket రూపాలను support చేస్తుంది.
- **Glossary management**: domain glossary packages import, export, merge మరియు priority policies కు support ఇస్తుంది; translation prompt flow లో వాటిని inject చేస్తుంది.
- **Secure credential management**: API Key వంటి sensitive information Windows Credential Manager లో నిల్వ అవుతుంది; business configuration లో plaintext గా రాయబడదు.
- **Diagnostics మరియు quality gates**: driver health probes, model Trace, log export, Watch Mode live-link tests మరియు pre-release quality gates అందిస్తుంది.
- **20 UI languages**: ప్రస్తుతం UI language resources `ar`, `bn`, `de`, `en`, `es`, `fil`, `fr`, `hi`, `id`, `ja`, `ko`, `mr`, `pt`, `ru`, `ta`, `te`, `th`, `tr`, `vi`, `zh-CN` ను కవర్ చేస్తున్నాయి.

## త్వరిత ప్రారంభం

### అవసరాలు

- **Node.js** >= 20
- **Rust stable**, edition 2021
- **Windows 10/11**
- **Visual Studio 2022 + WDK 10.0.26100**, virtual audio driver build చేయడానికి మాత్రమే అవసరం
- development driver loading కు Windows TESTSIGNING mode అవసరం; సాధారణ frontend preview కు driver లేదా administrator privileges అవసరం లేదు

### ఇన్‌స్టాల్ చేసి రన్ చేయడం

```bash
# 1. repository clone చేయండి
git clone <repo-url>
cd omni-translate

# 2. dependencies install చేయండి
npm install

# 3. frontend browser preview start చేయండి
npm run dev:desktop

# 4. పూర్తి Tauri desktop app start చేయండి
npm run dev:desktop-shell
```

Browser preview mode స్వయంచాలకంగా Mock runtime ను ఉపయోగిస్తుంది; UI development మరియు page checks కు ఇది సరిపోతుంది. పూర్తి desktop app Tauri/Rust runtime ను start చేస్తుంది, driver installation లేదా repair actions ఉన్నప్పుడు మాత్రమే elevation flow trigger అవుతుంది.

### సాధారణ కమాండ్లు

| కమాండ్ | వివరణ |
| --- | --- |
| `npm run dev:desktop` | React/Vite frontend development server ను start చేస్తుంది |
| `npm run dev:desktop-shell` | elevation script ద్వారా పూర్తి Tauri desktop app ను start చేస్తుంది |
| `npm run lint:desktop` | desktop frontend ESLint ను run చేస్తుంది |
| `npm run check:desktop` | TypeScript type checking ను run చేస్తుంది |
| `npm run build:desktop` | frontend assets ను build చేస్తుంది |
| `npm run check:desktop-shell` | Tauri Rust backend ను check చేస్తుంది |
| `npm run build:desktop-shell` | పూర్తి Tauri app ను build చేస్తుంది |
| `npm run build:bridge-service-native` | Rust Native Bridge Service ను build చేస్తుంది |
| `npm run test:all` | full test entrypoint ను run చేస్తుంది |
| `npm run test:contracts` | frozen contracts ను verify చేస్తుంది |
| `npm run test:watch-mode-live:dry-run` | Watch Mode live-link dry-run ను run చేస్తుంది |
| `npm run quality:gate:auto` | automated quality gate ను run చేస్తుంది |
| `npm run quality:gate:release` | release quality gate ను run చేస్తుంది |
| `npm run driver:build-sysvad` | SYSVAD virtual audio driver ను build చేస్తుంది |
| `npm run driver:install` | development driver ను install చేస్తుంది |
| `npm run driver:test` | development driver status ను probe చేస్తుంది |
| `npm run driver:uninstall` | development driver ను uninstall చేస్తుంది |
| `npm run release:prepare` | విడుదల సిద్ధీకరణ pipeline ను రన్ చేస్తుంది |

## సిస్టమ్ ఆర్కిటెక్చర్

```text
┌────────────────────────────────────────────────────────────┐
│ 1. Desktop Shell                                            │
│    Tauri 2 + React 19 + TypeScript 6 + Vite 8/Rolldown      │
│    main window, subtitle floating window, routing, settings,│
│    diagnostics, Provider pages                              │
├────────────────────────────────────────────────────────────┤
│ 2. Rust Core Runtime                                        │
│    Tauri commands/events, session orchestration, config      │
│    storage, diagnostics, tray integration                    │
├────────────────────────────────────────────────────────────┤
│ 3. Audio Layer                                              │
│    WASAPI + cpal + rodio, system audio/microphone capture,   │
│    VAD, segmentation, mixing                                │
├────────────────────────────────────────────────────────────┤
│ 4. AI Gateway                                               │
│    reqwest + tungstenite, ASR / Translation / TTS Provider   │
│    DashScope and OpenAI-compatible templates, capability     │
│    probes, error normalization                               │
├────────────────────────────────────────────────────────────┤
│ 5. Native Bridge Service                                    │
│    Rust sidecar, WASAPI, Named Pipe IPC, audio frames,       │
│    driver IOCTL                                             │
├────────────────────────────────────────────────────────────┤
│ 6. Driver / Installer                                       │
│    SYSVAD WaveRT virtual audio driver, install, rollback,    │
│    repair and health probing                                │
└────────────────────────────────────────────────────────────┘
```

## డైరెక్టరీ నిర్మాణం

```text
omni-translate/
├── apps/
│   ├── desktop/                    # Tauri desktop app
│   │   ├── src/                    # React frontend
│   │   │   ├── components/         # shared UI components
│   │   │   ├── i18n/               # 20 UI language resources
│   │   │   ├── pages/              # session, routing, Provider, glossary, settings, diagnostics pages
│   │   │   ├── runtime/            # frontend runtime/IPC adapter layer
│   │   │   ├── schema/             # TypeScript contracts and types
│   │   │   └── stores/             # Zustand state
│   │   └── src-tauri/              # Rust desktop shell
│   │       └── src/
│   │           ├── audio/          # audio engine, STT, TTS, translation routing, realtime Provider
│   │           ├── bridge/         # Bridge/driver installation and IPC contracts
│   │           ├── diagnostics/    # logs, Trace, diagnostic state
│   │           ├── provider/       # AI Gateway, Provider templates, HTTP/WS transport
│   │           ├── runtime/        # windows, tray, runtime state
│   │           └── storage/        # SQLite repository and credential management
│   └── bridge-service-native/      # Rust Native Bridge Service, only production bridge implementation
├── drivers/
│   └── windows-virtual-mic/        # SYSVAD WaveRT virtual audio driver
│       ├── include/                # Driver/Bridge shared IOCTL ABI
│       ├── package/                # driver package metadata
│       └── sysvad/                 # driver source modified from Microsoft SYSVAD sample
├── scripts/
│   ├── development/                # development launch scripts
│   ├── diagnostics/                # diagnostic tools
│   ├── installer/                  # driver build, install, uninstall, repair, probe
│   ├── release/                    # release verification, manifest, packaging, signing manifest
│   └── testing/                    # tests, coverage, quality gates, Watch Mode links
├── docs/                           # architecture, quality, project docs and Provider/API materials
└── artifacts/                      # build artifacts, logs and diagnostic output
```

## ప్రధాన ఫ్లోలు

### ఇన్‌బౌండ్ అనువాదం (వీక్షణ/సబ్‌టైటిల్ సందర్భాలు)

```text
system audio
  → virtual audio driver / WASAPI capture
  → Native Bridge Service
  → Desktop Rust Audio Layer
  → VAD / segmentation
  → ASR
  → Translation Provider
  → subtitle rendering (main window + floating window)
  → optional TTS
  → local speaker / monitor output
```

### ఔట్‌బౌండ్ అనువాదం (వాయిస్ రూమ్/మీటింగ్/గేమ్ సందర్భాలు)

```text
microphone
  → Desktop Rust Audio Layer
  → VAD / segmentation
  → ASR
  → Translation Provider
  → TTS
  → Native Bridge Service
  → virtual audio driver
  → target app virtual microphone / virtual endpoint ను read చేస్తుంది
```

### లేటెన్సీ మరియు డిగ్రేడెడ్ వ్యూహం

- Subtitles మరియు dubbed speech వేర్వేరు scheduling results; subtitles ముందుగా commit అవుతాయి.
- Provider latency budget దాటితే `latency-high` emit అవుతుంది, subtitles కొనసాగుతాయి, TTS deferred/queued state కు మారుతుంది.
- Provider probing real-time use కు సరిపోదని గుర్తిస్తే, dubbed speech overlay default గా disable అవుతుంది; subtitle-first path మాత్రమే active గా ఉంటుంది.
- Driver లేదా Bridge failures app startup ను block చేయవు; subtitles, local playback మరియు diagnostics page degraded mode లో కూడా అందుబాటులో ఉండాలి.

## టెక్ స్టాక్

| స్థాయి | టెక్నాలజీ |
| --- | --- |
| Frontend | React 19.2.x, TypeScript 6.0.x, Vite 8.x, Rolldown, CSS |
| Desktop shell | Tauri 2.x, `@tauri-apps/api`, `@tauri-apps/cli` |
| State and routing | Zustand 5.x, react-router-dom 7.x |
| Internationalization | i18next 26.x, react-i18next 17.x, i18next-browser-languagedetector |
| Frontend testing | Vitest 4.x, jsdom 29.x, ESLint 10.x |
| Rust runtime | Rust 2021, Serde, Tauri commands/events |
| Provider networking layer | reqwest 0.13, tungstenite 0.29, rustls |
| Storage and credentials | rusqlite 0.40 bundled SQLite, keyring 4, Windows Credential Manager |
| Audio | cpal 0.17, rodio 0.22, wasapi 0.23, hound, minimp3 |
| System interfaces | windows-sys 0.61 |
| Native Bridge | Rust sidecar, WASAPI, Named Pipe, IOCTL ABI |
| Driver | Windows SYSVAD WaveRT virtual audio driver |
| Scripts | PowerShell, Node.js release/testing scripts |

## కాంట్రాక్టులు మరియు డేటా సరిహద్దులు

Project ప్రస్తుతం నాలుగు రకాల frozen contract areas ను ప్రధానంగా maintain చేస్తోంది:

1. **Provider Contract**: Provider metadata, auth references, request parameters, streaming events, error structures మరియు capability probe results.
2. **Audio Contract**: system audio, microphone, PCM frames, segments, mixing, latency compensation మరియు Push-to-talk state.
3. **Driver Bridge Contract**: Desktop, Native Bridge మరియు driver మధ్య initialization, audio frames, state queries, error events మరియు shutdown protocol.
4. **OBS Integration Contract**: భవిష్యత్తులో OBS subtitle overlay మరియు scene trigger support కోసం reserve చేసిన connection మరియు output boundary.

Structured configuration SQLite ను ప్రధాన నిజమైన మూలంగా ఉపయోగిస్తుంది. Sensitive credentials Windows Credential Manager లో నిల్వ అవుతాయి. Logs, caches, glossary packages మరియు temporary audio files వేర్వేరు directories లో ఉంచబడతాయి.

## నాణ్యత మరియు టెస్టింగ్

- `npm run verify:desktop`: desktop frontend lint, typecheck, test, build.
- `npm run test:desktop-shell`: Tauri Rust backend tests.
- `npm run test:bridge-service-native`: Native Bridge Rust tests.
- `npm run test:contracts`: TypeScript/Rust/script-side frozen contract verification.
- `npm run quality:gate:auto`: automated quality gate.
- `npm run quality:gate:release`: manual verification entrypoints కలిగిన pre-release quality gate.
- `npm run test:watch-mode-report` / `npm run test:watch-mode-live:*`: Watch Mode reports, evidence మరియు live-link test entrypoints.

## డెవలప్‌మెంట్

### ఫ్రంట్‌ఎండ్ డెవలప్‌మెంట్

Frontend ను `npm run dev:desktop` తో browser లో నేరుగా develop చేయవచ్చు. Non-Tauri environments లో runtime layer Mock data return చేస్తుంది, కాబట్టి driver install చేయకుండా లేదా Rust backend start చేయకుండా pages మరియు interactions check చేయవచ్చు.

### Rust డెస్క్‌టాప్ షెల్

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

### డ్రైవర్ డెవలప్‌మెంట్

Driver build చేయడానికి Visual Studio 2022 + WDK అవసరం. Development driver install చేయడానికి administrator privileges మరియు TESTSIGNING mode అవసరం.

```bash
npm run driver:build-sysvad
npm run driver:install
npm run driver:test
npm run driver:uninstall
```

## లైసెన్స్

ఈ project private license (Private) కింద ఉంటుంది. అన్ని హక్కులు reserve చేయబడ్డాయి.
