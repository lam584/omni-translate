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
        <b>ไทย</b> |
        <a href="README_fil.md">Filipino</a> |
        <a href="README_tr.md">Türkçe</a>
    </p>
</h4>

Omni Translate เป็นแอปเดสก์ท็อปสำหรับสถานการณ์การแปลเสียงแบบเรียลไทม์บน Windows ครอบคลุมเวิร์กโฟลว์อย่างการแปลคำบรรยายวิดีโอ การแปลเสียงในเกม และการแปลสองทางสำหรับห้องเสียง/การประชุม แอปเชื่อม virtual audio driver, Native Bridge, Rust Core และ unified AI Gateway เข้าด้วยกันเพื่อประมวลผลการจับเสียงระบบ การรู้จำเสียง การแปลด้วย LLM การสังเคราะห์เสียง การเรนเดอร์คำบรรยาย และการเล่นเสียง

## ฟีเจอร์เด่น

- **การแปลคำบรรยายแบบเรียลไทม์**: จับเสียงระบบหรือเสียงไมโครโฟน รู้จำแบบเรียลไทม์ และแสดงคำบรรยายที่แปลแล้ว รองรับทั้งหน้าต่างหลักและหน้าต่างลอย
- **หน้าต่างคำบรรยายลอย**: หน้าต่างอิสระแบบโปร่งใส ไม่มีขอบ และอยู่ด้านบนเสมอ สามารถวางทับวิดีโอ เกม หรือซอฟต์แวร์ประชุมได้
- **การแปลเสียงสองทาง**: รองรับโหมด routing สำหรับการรับชม เกม และห้องเสียง ครอบคลุมคำบรรยาย/เสียงแปลขาเข้าและเอาต์พุตไมโครโฟนเสมือนขาออก
- **Virtual audio driver**: Windows virtual audio driver ที่ใช้ SYSVAD WaveRT และสื่อสารกับ bridge service ฝั่ง user mode ผ่าน IOCTL/shared ABI
- **Rust Native Bridge**: `apps/bridge-service-native` เป็น production bridge implementation เพียงตัวเดียวในปัจจุบัน รับผิดชอบ WASAPI, Named Pipe IPC, audio frames และการสื่อสารกับ driver
- **Unified AI Gateway**: เชื่อมต่อ DashScope และอินเทอร์เฟซที่เข้ากันได้กับ OpenAI แบบ template-driven รองรับ HTTP, streaming HTTP และ WebSocket
- **การจัดการ glossary**: รองรับการ import, export, merge และ priority policy ของ domain glossary packages แล้ว inject เข้าสู่ translation prompt flow
- **การจัดการ credentials อย่างปลอดภัย**: ข้อมูลสำคัญอย่าง API Key ถูกเก็บใน Windows Credential Manager ไม่เขียนเป็น plaintext ใน business configuration
- **Diagnostics และ quality gates**: มี driver health probes, model Trace, log export, Watch Mode live-link tests และ quality gates ก่อน release
- **ภาษา UI 20 ภาษา**: ทรัพยากรภาษา UI ปัจจุบันครอบคลุม `ar`, `bn`, `de`, `en`, `es`, `fil`, `fr`, `hi`, `id`, `ja`, `ko`, `mr`, `pt`, `ru`, `ta`, `te`, `th`, `tr`, `vi`, `zh-CN`

## เริ่มต้นอย่างรวดเร็ว

### ข้อกำหนด

- **Node.js** >= 20
- **Rust stable**, edition 2021
- **Windows 10/11**
- **Visual Studio 2022 + WDK 10.0.26100** จำเป็นเฉพาะเมื่อ build virtual audio driver
- การโหลด development driver ต้องใช้ Windows TESTSIGNING mode; การ preview frontend ตามปกติไม่ต้องใช้ driver หรือสิทธิ์ administrator

### ติดตั้งและรัน

```bash
# 1. clone repository
git clone <repo-url>
cd omni-translate

# 2. install dependencies
npm install

# 3. start frontend browser preview
npm run dev:desktop

# 4. start full Tauri desktop app
npm run dev:desktop-shell
```

โหมด browser preview จะใช้ Mock runtime โดยอัตโนมัติ เหมาะสำหรับการพัฒนา UI และตรวจหน้าเว็บ แอปเดสก์ท็อปเต็มรูปแบบจะเริ่ม Tauri/Rust runtime และจะ trigger elevation flow เฉพาะเมื่อมีการติดตั้งหรือซ่อมแซม driver

### คำสั่งที่ใช้บ่อย

| คำสั่ง | คำอธิบาย |
| --- | --- |
| `npm run dev:desktop` | เริ่ม React/Vite frontend development server |
| `npm run dev:desktop-shell` | เริ่ม Tauri desktop app แบบเต็มผ่าน elevation script |
| `npm run lint:desktop` | รัน ESLint สำหรับ desktop frontend |
| `npm run check:desktop` | รัน TypeScript type checking |
| `npm run build:desktop` | build frontend assets |
| `npm run check:desktop-shell` | ตรวจ Tauri Rust backend |
| `npm run build:desktop-shell` | build Tauri app แบบเต็ม |
| `npm run build:bridge-service-native` | build Rust Native Bridge Service |
| `npm run test:all` | รัน full test entrypoint |
| `npm run test:contracts` | ตรวจสอบ frozen contracts |
| `npm run test:watch-mode-live:dry-run` | รัน Watch Mode live-link dry-run |
| `npm run quality:gate:auto` | รัน automated quality gate |
| `npm run quality:gate:release` | รัน release quality gate |
| `npm run driver:build-sysvad` | build SYSVAD virtual audio driver |
| `npm run driver:install` | ติดตั้ง development driver |
| `npm run driver:test` | probe สถานะ development driver |
| `npm run driver:uninstall` | uninstall development driver |
| `npm run release:prepare` | รันไปป์ไลน์เตรียมรีลีส |

## สถาปัตยกรรมระบบ

```text
┌────────────────────────────────────────────────────────────┐
│ 1. Desktop Shell                                            │
│    Tauri 2 + React 19 + TypeScript 6 + Vite 8/Rolldown      │
│    หน้าต่างหลัก, หน้าต่างคำบรรยายลอย, routing, settings,     │
│    diagnostics, หน้า Provider                               │
├────────────────────────────────────────────────────────────┤
│ 2. Rust Core Runtime                                        │
│    Tauri commands/events, การจัดการ session, config storage, │
│    diagnostics, tray integration                            │
├────────────────────────────────────────────────────────────┤
│ 3. Audio Layer                                              │
│    WASAPI + cpal + rodio, จับเสียงระบบ/ไมโครโฟน, VAD,        │
│    segmentation, mixing                                     │
├────────────────────────────────────────────────────────────┤
│ 4. AI Gateway                                               │
│    reqwest + tungstenite, ASR / Translation / TTS Provider   │
│    DashScope และ OpenAI-compatible templates, capability     │
│    probes, error normalization                              │
├────────────────────────────────────────────────────────────┤
│ 5. Native Bridge Service                                    │
│    Rust sidecar, WASAPI, Named Pipe IPC, audio frames,       │
│    driver IOCTL                                             │
├────────────────────────────────────────────────────────────┤
│ 6. Driver / Installer                                       │
│    SYSVAD WaveRT virtual audio driver, install, rollback,    │
│    repair และ health probing                                │
└────────────────────────────────────────────────────────────┘
```

## โครงสร้างไดเรกทอรี

```text
omni-translate/
├── apps/
│   ├── desktop/                    # Tauri desktop app
│   │   ├── src/                    # React frontend
│   │   │   ├── components/         # shared UI components
│   │   │   ├── i18n/               # ทรัพยากรภาษา UI 20 ภาษา
│   │   │   ├── pages/              # session, routing, Provider, glossary, settings, diagnostics pages
│   │   │   ├── runtime/            # frontend runtime/IPC adapters
│   │   │   ├── schema/             # TypeScript contracts and types
│   │   │   └── stores/             # Zustand state
│   │   └── src-tauri/              # Rust desktop shell
│   │       └── src/
│   │           ├── audio/          # audio engine, STT, TTS, translation routing, realtime Provider
│   │           ├── bridge/         # Bridge/driver installation and IPC contracts
│   │           ├── diagnostics/    # logs, Trace, diagnostic state
│   │           ├── provider/       # AI Gateway, Provider templates, HTTP/WS transport
│   │           ├── runtime/        # windows, tray, runtime state
│   │           └── storage/        # SQLite repository and credential handling
│   └── bridge-service-native/      # Rust Native Bridge Service, production bridge implementation เพียงตัวเดียว
├── drivers/
│   └── windows-virtual-mic/        # SYSVAD WaveRT virtual audio driver
│       ├── include/                # Driver/Bridge shared IOCTL ABI
│       ├── package/                # driver package metadata
│       └── sysvad/                 # driver source ที่ปรับจาก Microsoft SYSVAD sample
├── scripts/
│   ├── development/                # development launch scripts
│   ├── diagnostics/                # diagnostic tools
│   ├── installer/                  # driver build, install, uninstall, repair, probe
│   ├── release/                    # release verification, manifest, packaging, signing manifest
│   └── testing/                    # tests, coverage, quality gates, Watch Mode links
├── docs/                           # architecture, quality, project docs และ Provider/API references
└── artifacts/                      # build outputs, logs และ diagnostic output
```

## โฟลว์หลัก

### การแปลขาเข้า (สถานการณ์รับชม/คำบรรยาย)

```text
เสียงระบบ
  → virtual audio driver / WASAPI capture
  → Native Bridge Service
  → Desktop Rust Audio Layer
  → VAD / segmentation
  → ASR
  → Translation Provider
  → การเรนเดอร์คำบรรยาย (หน้าต่างหลัก + หน้าต่างลอย)
  → TTS แบบเลือกได้
  → ลำโพงเครื่อง / monitor output
```

### การแปลขาออก (สถานการณ์ห้องเสียง/ประชุม/เกม)

```text
ไมโครโฟน
  → Desktop Rust Audio Layer
  → VAD / segmentation
  → ASR
  → Translation Provider
  → TTS
  → Native Bridge Service
  → virtual audio driver
  → แอปเป้าหมายอ่าน virtual microphone / virtual endpoint
```

### เวลาแฝงและกลยุทธ์โหมดลดระดับ

- คำบรรยายและเสียงพากย์แปลเป็นผลลัพธ์การ scheduling ที่แยกกัน โดย commit คำบรรยายก่อน
- เมื่อ latency ของ Provider เกินงบประมาณ จะ emit `latency-high` คำบรรยายยังออกต่อ และ TTS จะเข้าสู่สถานะ deferred/queued
- เมื่อ provider probing ระบุว่า provider ไม่เหมาะกับการใช้งาน real time จะปิด dubbed speech overlay โดย default และคงเส้นทาง subtitle-first ไว้
- ความผิดปกติของ driver หรือ Bridge จะไม่ block การเริ่มแอป; คำบรรยาย การเล่นในเครื่อง และหน้า diagnostics ควรยังใช้งานได้ใน degraded mode

## สแต็กเทคโนโลยี

| ชั้น | เทคโนโลยี |
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

## สัญญาและขอบเขตข้อมูล

โปรเจกต์ปัจจุบันดูแล frozen contract หลัก 4 กลุ่ม:

1. **Provider Contract**: Provider metadata, auth references, request parameters, streaming events, error structures และ capability probe results
2. **Audio Contract**: system audio, microphone, PCM frames, segments, mixing, latency compensation และ Push-to-talk state
3. **Driver Bridge Contract**: initialization, audio frames, state queries, error events และ shutdown protocol ระหว่าง Desktop, Native Bridge และ driver
4. **OBS Integration Contract**: connection และ output boundary ที่เตรียมไว้สำหรับ OBS subtitle overlay และ scene trigger support ในอนาคต

Structured configuration ใช้ SQLite เป็นแหล่งข้อมูลหลัก ส่วน sensitive credentials เก็บใน Windows Credential Manager และ logs, caches, glossary packages, temporary audio files ถูกแยกตาม directory

## คุณภาพและการทดสอบ

- `npm run verify:desktop`: desktop frontend lint, typecheck, test และ build
- `npm run test:desktop-shell`: Tauri Rust backend tests
- `npm run test:bridge-service-native`: Native Bridge Rust tests
- `npm run test:contracts`: ตรวจสอบ frozen contracts ฝั่ง TypeScript/Rust/script
- `npm run quality:gate:auto`: automated quality gate
- `npm run quality:gate:release`: quality gate ก่อน release พร้อม manual verification entrypoints
- `npm run test:watch-mode-report` / `npm run test:watch-mode-live:*`: Watch Mode reports, evidence และ live-link test entrypoints

## การพัฒนา

### การพัฒนาฟรอนต์เอนด์

สามารถพัฒนา frontend ใน browser ได้โดยตรงด้วย `npm run dev:desktop` ในสภาพแวดล้อมที่ไม่ใช่ Tauri ชั้น runtime จะคืน Mock data เพื่อให้ตรวจหน้าและ interaction ได้โดยไม่ต้องติดตั้ง driver หรือเริ่ม Rust backend

### Rust desktop shell

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

### การพัฒนาไดรเวอร์

การ build driver ต้องใช้ Visual Studio 2022 + WDK การติดตั้ง development driver ต้องใช้สิทธิ์ administrator และ TESTSIGNING mode

```bash
npm run driver:build-sysvad
npm run driver:install
npm run driver:test
npm run driver:uninstall
```

## ใบอนุญาต

โปรเจกต์นี้ใช้ private license (Private) สงวนลิขสิทธิ์ทั้งหมด
