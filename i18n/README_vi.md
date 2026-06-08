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
        <b>Tiếng Việt</b> |
        <a href="README_ja.md">日本語</a> |
        <a href="README_te.md">తెలుగు</a> |
        <a href="README_ta.md">தமிழ்</a> |
        <a href="README_mr.md">मराठी</a> |
        <a href="README_th.md">ไทย</a> |
        <a href="README_fil.md">Filipino</a> |
        <a href="README_tr.md">Türkçe</a>
    </p>
</h4>

Omni Translate là ứng dụng desktop Windows dành cho dịch âm thanh thời gian thực. Ứng dụng hướng đến các workflow như dịch phụ đề video, dịch giọng nói trong game và dịch hai chiều cho phòng thoại hoặc cuộc họp. Ứng dụng kết nối virtual audio driver, Native Bridge, Rust core runtime và unified AI gateway để xử lý audio capture, ASR, dịch bằng LLM, TTS, subtitle rendering và playback routing.

## Tính Năng

- **Dịch phụ đề thời gian thực**: Thu âm thanh hệ thống hoặc micro, nhận dạng lời nói và hiển thị phụ đề đã dịch trong cửa sổ chính và overlay.
- **Overlay phụ đề nổi**: Cửa sổ trong suốt, không viền, always-on-top, được thiết kế để nằm trên video, game hoặc ứng dụng họp.
- **Dịch giọng nói hai chiều**: Hỗ trợ các chế độ routing watch, game và voice room cho phụ đề/giọng nói inbound và output virtual microphone outbound.
- **Virtual audio driver**: Virtual audio driver Windows dựa trên SYSVAD WaveRT, kết nối với user mode qua IOCTL và shared ABI.
- **Rust Native Bridge**: `apps/bridge-service-native` là implementation bridge production duy nhất, xử lý WASAPI, Named Pipe IPC, audio frames và giao tiếp driver.
- **Unified AI Gateway**: Tích hợp provider DashScope và OpenAI-compatible dựa trên template với các transport HTTP, streaming HTTP và WebSocket.
- **Quản lý glossary**: Import, export, merge và ưu tiên các domain glossary package, sau đó inject chúng vào translation prompt flow.
- **Lưu trữ credential an toàn**: API key và các secret khác được lưu trong Windows Credential Manager thay vì plaintext business configuration.
- **Diagnostics và quality gates**: Driver health probes, model traces, log export, Watch Mode live-link tests và release quality gates.
- **20 ngôn ngữ UI**: Locale resources hiện tại bao phủ `ar`, `bn`, `de`, `en`, `es`, `fil`, `fr`, `hi`, `id`, `ja`, `ko`, `mr`, `pt`, `ru`, `ta`, `te`, `th`, `tr`, `vi` và `zh-CN`.

## Bắt Đầu Nhanh

### Yêu Cầu

- **Node.js** >= 20
- **Rust stable**, edition 2021
- **Windows 10/11**
- **Visual Studio 2022 + WDK 10.0.26100**, chỉ cần khi build virtual audio driver
- Việc load development drivers yêu cầu chế độ Windows TESTSIGNING; frontend preview thông thường không cần driver hoặc quyền administrator

### Cài Đặt và Chạy

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

Chế độ browser preview tự động dùng mock runtime, phù hợp cho phát triển UI và kiểm tra trang. Ứng dụng desktop đầy đủ khởi động Tauri/Rust runtime và chỉ kích hoạt elevation khi có thao tác liên quan đến cài đặt hoặc sửa chữa driver.

### Lệnh Thường Dùng

| Lệnh | Mô tả |
| --- | --- |
| `npm run dev:desktop` | Khởi động React/Vite frontend dev server |
| `npm run dev:desktop-shell` | Khởi động ứng dụng Tauri desktop đầy đủ thông qua elevation script |
| `npm run lint:desktop` | Chạy ESLint cho desktop frontend |
| `npm run check:desktop` | Chạy TypeScript type checking |
| `npm run build:desktop` | Xây dựng tài nguyên frontend |
| `npm run check:desktop-shell` | Kiểm tra Tauri Rust backend |
| `npm run build:desktop-shell` | Build ứng dụng Tauri đầy đủ |
| `npm run build:bridge-service-native` | Build Rust Native Bridge Service |
| `npm run test:all` | Chạy full test entrypoint |
| `npm run test:contracts` | Xác minh frozen contracts |
| `npm run test:watch-mode-live:dry-run` | Chạy Watch Mode live-link dry-run |
| `npm run quality:gate:auto` | Chạy automated quality gate |
| `npm run quality:gate:release` | Chạy release quality gate |
| `npm run driver:build-sysvad` | Build SYSVAD virtual audio driver |
| `npm run driver:install` | Cài development driver |
| `npm run driver:test` | Probe status của development driver |
| `npm run driver:uninstall` | Gỡ development driver |
| `npm run release:prepare` | Chạy pipeline chuẩn bị phát hành |

## Kiến Trúc

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

## Cấu Trúc Thư Mục

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

## Luồng Chính

### Dịch Đầu Vào (Kịch Bản Watch / Subtitle)

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

### Dịch Đầu Ra (Kịch Bản Voice Room / Meeting / Game)

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

### Độ Trễ và Chế Độ Giảm Cấp

- Subtitles và dubbed speech là các kết quả scheduling riêng biệt; subtitles được commit trước.
- Khi provider latency vượt budget, `latency-high` được emit, subtitles tiếp tục xuất ra, còn TTS chuyển sang trạng thái deferred/queued.
- Khi provider probing đánh dấu provider không phù hợp cho real time, dubbed speech mặc định bị tắt và subtitle-first path vẫn hoạt động.
- Lỗi Driver hoặc Bridge không chặn app startup; subtitles, local playback và diagnostics vẫn phải khả dụng trong degraded mode.

## Ngăn Xếp Công Nghệ

| Layer | Công nghệ |
| --- | --- |
| Frontend | React 19.2.x, TypeScript 6.0.x, Vite 8.x, Rolldown, CSS |
| Desktop shell | Tauri 2.x, `@tauri-apps/api`, `@tauri-apps/cli` |
| State và routing | Zustand 5.x, react-router-dom 7.x |
| Internationalization | i18next 26.x, react-i18next 17.x, i18next-browser-languagedetector |
| Frontend testing | Vitest 4.x, jsdom 29.x, ESLint 10.x |
| Rust runtime | Rust 2021, Serde, Tauri commands/events |
| Provider networking | reqwest 0.13, tungstenite 0.29, rustls |
| Storage và credentials | rusqlite 0.40 bundled SQLite, keyring 4, Windows Credential Manager |
| Audio | cpal 0.17, rodio 0.22, wasapi 0.23, hound, minimp3 |
| System APIs | windows-sys 0.61 |
| Native Bridge | Rust sidecar, WASAPI, Named Pipe, IOCTL ABI |
| Driver | Windows SYSVAD WaveRT virtual audio driver |
| Scripts | PowerShell, Node.js release/testing scripts |

## Hợp Đồng và Ranh Giới Dữ Liệu

Dự án hiện duy trì bốn vùng frozen contract:

1. **Provider Contract**: Provider metadata, auth references, request parameters, streaming events, error structures và probe results.
2. **Audio Contract**: System audio, microphone, PCM frames, segments, mixing, latency compensation và push-to-talk state.
3. **Driver Bridge Contract**: Initialization, audio frames, state queries, error events và shutdown protocol giữa Desktop, Native Bridge và driver.
4. **OBS Integration Contract**: Connection và output boundary được dành sẵn cho hỗ trợ OBS subtitle overlay và scene trigger trong tương lai.

Structured configuration dùng SQLite làm main source of truth. Sensitive credentials được lưu trong Windows Credential Manager. Logs, caches, glossary packages và temporary audio files được tách vào các thư mục riêng.

## Chất Lượng và Kiểm Thử

- `npm run verify:desktop`: lint, typecheck, test và build cho desktop frontend.
- `npm run test:desktop-shell`: kiểm thử Tauri Rust backend.
- `npm run test:bridge-service-native`: kiểm thử Native Bridge Rust.
- `npm run test:contracts`: xác minh frozen contract phía TypeScript/Rust/script.
- `npm run quality:gate:auto`: automated quality gate.
- `npm run quality:gate:release`: release quality gate có manual verification entrypoints.
- `npm run test:watch-mode-report` / `npm run test:watch-mode-live:*`: Watch Mode reports, evidence và live-link test entrypoints.

## Phát Triển

### Phát Triển Frontend

Dùng `npm run dev:desktop` để phát triển frontend trong browser. Trong môi trường non-Tauri, runtime layer trả về mock data để có thể kiểm tra trang và tương tác mà không cần cài driver hoặc khởi động Rust backend.

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

### Phát Triển Driver

Build driver yêu cầu Visual Studio 2022 + WDK. Cài development driver yêu cầu quyền administrator và chế độ TESTSIGNING.

```bash
npm run driver:build-sysvad
npm run driver:install
npm run driver:test
npm run driver:uninstall
```

## Giấy Phép

Dự án này dùng giấy phép riêng tư. Bảo lưu mọi quyền.
