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
        <b>বাংলা</b> |
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

Omni Translate Windows-এর জন্য রিয়েল-টাইম অডিও অনুবাদের একটি ডেস্কটপ অ্যাপ। এটি ভিডিও সাবটাইটেল অনুবাদ, গেম ভয়েস অনুবাদ এবং ভয়েস রুম বা মিটিংয়ের দ্বিমুখী অনুবাদের মতো কর্মপ্রবাহকে লক্ষ্য করে। অ্যাপটি virtual audio driver, Native Bridge, Rust Core Runtime এবং unified AI Gateway যুক্ত করে audio capture, ASR, LLM translation, TTS, subtitle rendering এবং playback routing সম্পন্ন করে।

## প্রধান বৈশিষ্ট্য

- **রিয়েল-টাইম সাবটাইটেল অনুবাদ**: সিস্টেম অডিও বা মাইক্রোফোন অডিও ক্যাপচার করে, কথন শনাক্ত করে, এবং প্রধান উইন্ডো ও overlay-তে অনূদিত সাবটাইটেল দেখায়।
- **ভাসমান সাবটাইটেল overlay**: স্বচ্ছ, borderless, always-on-top স্বাধীন উইন্ডো, যা ভিডিও, গেম বা মিটিং অ্যাপের উপর বসানোর জন্য তৈরি।
- **দ্বিমুখী ভয়েস অনুবাদ**: watch, game এবং voice room routing mode সমর্থন করে; inbound subtitle/translated audio এবং outbound virtual microphone output কভার করে।
- **ভার্চুয়াল অডিও ড্রাইভার**: Windows SYSVAD WaveRT-ভিত্তিক virtual audio driver, যা IOCTL এবং shared ABI দিয়ে user-mode bridge service-এর সঙ্গে যুক্ত।
- **Rust Native Bridge**: `apps/bridge-service-native` বর্তমানে একমাত্র production bridge implementation; এটি WASAPI, Named Pipe IPC, audio frame এবং driver communication সামলায়।
- **Unified AI Gateway**: template-driven DashScope এবং OpenAI-compatible provider integration, HTTP, streaming HTTP এবং WebSocket transport সমর্থনসহ।
- **Glossary management**: domain glossary package import, export, merge ও priority policy সমর্থন করে এবং সেগুলো translation prompt flow-তে inject করে।
- **নিরাপদ credential storage**: API Key এবং অন্যান্য sensitive তথ্য business configuration-এ plaintext হিসেবে না লিখে Windows Credential Manager-এ রাখা হয়।
- **Diagnostics ও quality gates**: driver health probe, model Trace, log export, Watch Mode live-link test এবং release quality gate প্রদান করে।
- **20টি UI ভাষা**: বর্তমান locale resource `ar`, `bn`, `de`, `en`, `es`, `fil`, `fr`, `hi`, `id`, `ja`, `ko`, `mr`, `pt`, `ru`, `ta`, `te`, `th`, `tr`, `vi`, এবং `zh-CN` কভার করে।

## দ্রুত শুরু

### প্রয়োজনীয়তা

- **Node.js** >= 20
- **Rust stable**, edition 2021
- **Windows 10/11**
- **Visual Studio 2022 + WDK 10.0.26100**, virtual audio driver build করার সময়ই কেবল প্রয়োজন
- development driver load করতে Windows TESTSIGNING mode প্রয়োজন; সাধারণ frontend preview-তে driver বা administrator privilege লাগে না

### ইনস্টল ও চালানো

```bash
# 1. রিপোজিটরি clone করুন
git clone <repo-url>
cd omni-translate

# 2. নির্ভরতা install করুন
npm install

# 3. frontend browser preview শুরু করুন
npm run dev:desktop

# 4. পূর্ণ Tauri desktop app শুরু করুন
npm run dev:desktop-shell
```

Browser preview mode স্বয়ংক্রিয়ভাবে Mock runtime ব্যবহার করে, তাই এটি UI development এবং page check-এর জন্য উপযোগী। পূর্ণ desktop app Tauri/Rust runtime শুরু করে এবং driver installation বা repair action থাকলেই elevation flow চালায়।

### সাধারণ কমান্ড

| কমান্ড | বিবরণ |
| --- | --- |
| `npm run dev:desktop` | React/Vite frontend dev server শুরু করে |
| `npm run dev:desktop-shell` | elevation script দিয়ে পূর্ণ Tauri desktop app শুরু করে |
| `npm run lint:desktop` | desktop frontend-এর ESLint চালায় |
| `npm run check:desktop` | TypeScript type checking চালায় |
| `npm run build:desktop` | frontend asset build করে |
| `npm run check:desktop-shell` | Tauri Rust backend check করে |
| `npm run build:desktop-shell` | পূর্ণ Tauri app build করে |
| `npm run build:bridge-service-native` | Rust Native Bridge Service build করে |
| `npm run test:all` | পূর্ণ test entrypoint চালায় |
| `npm run test:contracts` | frozen contract verify করে |
| `npm run test:watch-mode-live:dry-run` | Watch Mode live-link dry-run চালায় |
| `npm run quality:gate:auto` | automated quality gate চালায় |
| `npm run quality:gate:release` | release quality gate চালায় |
| `npm run driver:build-sysvad` | SYSVAD virtual audio driver build করে |
| `npm run driver:install` | development driver install করে |
| `npm run driver:test` | development driver status probe করে |
| `npm run driver:uninstall` | development driver uninstall করে |
| `npm run release:prepare` | রিলিজ প্রস্তুতি পাইপলাইন চালায় |

## সিস্টেম আর্কিটেকচার

```text
┌────────────────────────────────────────────────────────────┐
│ 1. Desktop Shell                                            │
│    Tauri 2 + React 19 + TypeScript 6 + Vite 8/Rolldown      │
│    প্রধান উইন্ডো, subtitle overlay, routing, settings,      │
│    diagnostics, Provider page                               │
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
│    DashScope ও OpenAI-compatible template, capability probe, │
│    error normalization                                      │
├────────────────────────────────────────────────────────────┤
│ 5. Native Bridge Service                                    │
│    Rust sidecar, WASAPI, Named Pipe IPC, audio frame,        │
│    driver IOCTL                                             │
├────────────────────────────────────────────────────────────┤
│ 6. Driver / Installer                                       │
│    SYSVAD WaveRT virtual audio driver, install, rollback,    │
│    repair ও health probe                                    │
└────────────────────────────────────────────────────────────┘
```

## ডিরেক্টরি কাঠামো

```text
omni-translate/
├── apps/
│   ├── desktop/                    # Tauri desktop application
│   │   ├── src/                    # React frontend
│   │   │   ├── components/         # shared UI component
│   │   │   ├── i18n/               # 20টি UI locale resource
│   │   │   ├── pages/              # session, routing, Provider, glossary, settings, diagnostics page
│   │   │   ├── runtime/            # frontend runtime/IPC adapter layer
│   │   │   ├── schema/             # TypeScript contract ও type
│   │   │   └── stores/             # Zustand state
│   │   └── src-tauri/              # Rust desktop shell
│   │       └── src/
│   │           ├── audio/          # audio engine, STT, TTS, translation routing, realtime Provider
│   │           ├── bridge/         # Bridge/driver installation এবং IPC contract
│   │           ├── diagnostics/    # log, Trace, diagnostic state
│   │           ├── provider/       # AI Gateway, Provider template, HTTP/WS transport
│   │           ├── runtime/        # window, tray, runtime state
│   │           └── storage/        # SQLite repository ও credential handling
│   └── bridge-service-native/      # Rust Native Bridge Service, একমাত্র production bridge implementation
├── drivers/
│   └── windows-virtual-mic/        # SYSVAD WaveRT virtual audio driver
│       ├── include/                # Driver/Bridge shared IOCTL ABI
│       ├── package/                # driver package metadata
│       └── sysvad/                 # Microsoft SYSVAD sample থেকে modified driver source
├── scripts/
│   ├── development/                # development launch script
│   ├── diagnostics/                # diagnostic tool
│   ├── installer/                  # driver build, install, uninstall, repair, probe
│   ├── release/                    # release verification, manifest, packaging, signing manifest
│   └── testing/                    # test, coverage, quality gate, Watch Mode link
├── docs/                           # architecture, quality, project doc এবং Provider/API reference
└── artifacts/                      # build output, log ও diagnostic output
```

## মূল ফ্লো

### ইনবাউন্ড অনুবাদ (দেখা/সাবটাইটেল দৃশ্য)

```text
সিস্টেম অডিও
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

### আউটবাউন্ড অনুবাদ (ভয়েস রুম/মিটিং/গেম দৃশ্য)

```text
মাইক্রোফোন
  → Desktop Rust Audio Layer
  → VAD / segmentation
  → ASR
  → Translation Provider
  → TTS
  → Native Bridge Service
  → virtual audio driver
  → target app virtual microphone / virtual endpoint পড়ে
```

### লেটেন্সি ও অবনমিত মোড

- সাবটাইটেল এবং dubbed speech আলাদা scheduling result; সাবটাইটেল আগে commit করা হয়।
- Provider latency budget ছাড়ালে `latency-high` emit হয়, subtitles চলতে থাকে, এবং TTS deferred/queued state-এ যায়।
- Provider probe কোনো Provider-কে realtime ব্যবহারের জন্য অনুপযুক্ত চিহ্নিত করলে dubbed speech default ভাবে বন্ধ থাকে এবং subtitle-first path সক্রিয় থাকে।
- Driver বা Bridge failure app startup block করে না; subtitles, local playback এবং diagnostics degraded mode-এও উপলভ্য থাকা উচিত।

## টেক স্ট্যাক

| স্তর | প্রযুক্তি |
| --- | --- |
| Frontend | React 19.2.x, TypeScript 6.0.x, Vite 8.x, Rolldown, CSS |
| Desktop shell | Tauri 2.x, `@tauri-apps/api`, `@tauri-apps/cli` |
| State ও routing | Zustand 5.x, react-router-dom 7.x |
| Internationalization | i18next 26.x, react-i18next 17.x, i18next-browser-languagedetector |
| Frontend testing | Vitest 4.x, jsdom 29.x, ESLint 10.x |
| Rust runtime | Rust 2021, Serde, Tauri commands/events |
| Provider networking | reqwest 0.13, tungstenite 0.29, rustls |
| Storage ও credentials | rusqlite 0.40 bundled SQLite, keyring 4, Windows Credential Manager |
| Audio | cpal 0.17, rodio 0.22, wasapi 0.23, hound, minimp3 |
| System APIs | windows-sys 0.61 |
| Native Bridge | Rust sidecar, WASAPI, Named Pipe, IOCTL ABI |
| Driver | Windows SYSVAD WaveRT virtual audio driver |
| Scripts | PowerShell, Node.js release/testing scripts |

## কন্ট্র্যাক্ট ও ডেটা সীমা

প্রকল্পটি বর্তমানে চারটি frozen contract area রক্ষণাবেক্ষণ করে:

1. **Provider Contract**: Provider metadata, auth reference, request parameter, streaming event, error structure এবং capability probe result।
2. **Audio Contract**: system audio, microphone, PCM frame, segment, mixing, latency compensation এবং push-to-talk state।
3. **Driver Bridge Contract**: Desktop, Native Bridge এবং driver-এর মধ্যে initialization, audio frame, state query, error event এবং shutdown protocol।
4. **OBS Integration Contract**: ভবিষ্যৎ OBS subtitle overlay এবং scene trigger support-এর জন্য সংরক্ষিত connection ও output boundary।

Structured configuration প্রধান সত্যের উৎস হিসেবে SQLite ব্যবহার করে। Sensitive credential Windows Credential Manager-এ রাখা হয়। Log, cache, glossary package এবং temporary audio file আলাদা directory-তে রাখা হয়।

## গুণমান ও পরীক্ষা

- `npm run verify:desktop`: desktop frontend lint, typecheck, test এবং build।
- `npm run test:desktop-shell`: Tauri Rust backend test।
- `npm run test:bridge-service-native`: Native Bridge Rust test।
- `npm run test:contracts`: TypeScript/Rust/script-side frozen contract verification।
- `npm run quality:gate:auto`: automated quality gate।
- `npm run quality:gate:release`: manual verification entrypoint সহ release quality gate।
- `npm run test:watch-mode-report` / `npm run test:watch-mode-live:*`: Watch Mode report, evidence এবং live-link test entrypoint।

## ডেভেলপমেন্ট

### ফ্রন্টএন্ড উন্নয়ন

Frontend browser-এ develop করতে `npm run dev:desktop` ব্যবহার করুন। Non-Tauri environment-এ runtime layer Mock data ফেরত দেয়, তাই driver install বা Rust backend start না করেই page ও interaction check করা যায়।

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

### ড্রাইভার উন্নয়ন

Driver build করতে Visual Studio 2022 + WDK প্রয়োজন। Development driver install করতে administrator privilege এবং TESTSIGNING mode প্রয়োজন।

```bash
npm run driver:build-sysvad
npm run driver:install
npm run driver:test
npm run driver:uninstall
```

## লাইসেন্স

এই প্রকল্পটি private license-এর অধীনে। সর্বস্বত্ব সংরক্ষিত।
