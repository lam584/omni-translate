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
        <b>Bahasa Indonesia</b> |
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

Omni Translate adalah aplikasi desktop Windows untuk skenario terjemahan audio real-time, mencakup workflow seperti terjemahan subtitle video, terjemahan suara game, serta terjemahan dua arah untuk ruang suara atau rapat. Aplikasi menghubungkan virtual audio driver, Native Bridge, Rust Core, dan unified AI Gateway untuk menyambungkan system audio capture, ASR, terjemahan LLM, TTS, subtitle rendering, dan audio playback.

## Fitur

- **Terjemahan subtitle real-time**: Menangkap audio sistem atau mikrofon, mengenali secara real-time, dan menampilkan subtitle terjemahan, mendukung tampilan di jendela utama maupun jendela mengambang.
- **Overlay subtitle mengambang**: Jendela independen yang transparan, tanpa bingkai, dan always-on-top, dapat berada di atas video, game, atau software rapat.
- **Terjemahan suara dua arah**: Mendukung mode routing watch, game, dan voice room, mencakup subtitle/suara terjemahan inbound serta output virtual microphone outbound.
- **Virtual audio driver**: Virtual audio driver Windows berbasis SYSVAD WaveRT, berkomunikasi dengan bridge service user mode melalui IOCTL/shared ABI.
- **Rust Native Bridge**: `apps/bridge-service-native` adalah satu-satunya implementasi bridge produksi saat ini, menangani WASAPI, Named Pipe IPC, audio frame, dan interaksi driver.
- **Unified AI Gateway**: Integrasi provider DashScope dan OpenAI-compatible berbasis template, mendukung bentuk HTTP, streaming HTTP, dan WebSocket.
- **Manajemen glossary**: Mendukung import, export, merge, dan strategi prioritas paket glossary domain, lalu menyuntikkannya ke alur translation prompt.
- **Manajemen credential aman**: Informasi sensitif seperti API Key disimpan di Windows Credential Manager, tidak ditulis sebagai plaintext ke konfigurasi bisnis.
- **Diagnostics dan quality gate**: Menyediakan driver health probe, model Trace, log export, Watch Mode live-link test, dan quality gate sebelum rilis.
- **20 bahasa UI**: Resource bahasa UI saat ini mencakup `ar`, `bn`, `de`, `en`, `es`, `fil`, `fr`, `hi`, `id`, `ja`, `ko`, `mr`, `pt`, `ru`, `ta`, `te`, `th`, `tr`, `vi`, dan `zh-CN`.

## Mulai Cepat

### Prasyarat

- **Node.js** >= 20
- **Rust stable**, edition 2021
- **Windows 10/11**
- **Visual Studio 2022 Build Tools + Desktop development with C++**, diperlukan saat mengompilasi Tauri desktop shell dan Native Bridge; `cl.exe` dan `link.exe` harus dapat ditemukan dari command line
- **WDK 10.0.26100**, hanya diperlukan saat mengompilasi virtual audio driver
- Memuat development driver memerlukan mode Windows TESTSIGNING; frontend preview normal tidak memerlukan driver atau hak administrator

### Instalasi dan Menjalankan

```bash
# 1. Clone repositori
git clone <repo-url>
cd omni-translate

# 2. Install dependencies sesuai package-lock.json
npm ci

# 3. Mulai frontend browser preview
npm run dev:desktop

# 4. Mulai aplikasi desktop Tauri penuh
npm run dev:desktop-shell
```

Mode browser preview otomatis menggunakan mock runtime, sehingga cocok untuk pengembangan UI dan pemeriksaan halaman. Aplikasi desktop penuh memulai runtime Tauri/Rust dan hanya memicu elevation saat tindakan instalasi atau perbaikan driver terlibat.

Sebelum menjalankan desktop shell penuh untuk pertama kalinya, disarankan masuk ke repositori dari **Developer PowerShell** atau **x64 Native Tools Command Prompt** milik Visual Studio 2022. Jika PowerShell biasa menampilkan error `link.exe not found`, muat dulu environment MSVC:

```powershell
& "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\Launch-VsDevShell.ps1" -Arch amd64 -HostArch amd64
npm run dev:desktop-shell
```

`dev:desktop-shell` akan membangun versi release Native Bridge terlebih dahulu, lalu memulai Vite, Rust Core, dan jendela desktop melalui Tauri dev; skrip ini akan meminta UAC. Build Rust pertama memerlukan waktu untuk mengunduh dan mengompilasi dependency, sehingga durasinya jauh lebih lama dibanding start berikutnya.

### Perintah Umum

| Perintah | Deskripsi |
| --- | --- |
| `npm run dev:desktop` | Memulai React/Vite frontend dev server |
| `npm run dev:desktop-shell` | Memulai aplikasi desktop Tauri penuh melalui elevation script |
| `npm run dev:desktop:fast` | Melewati rebuild release Native Bridge dan elevation, memakai ulang Cargo incremental cache untuk pengembangan desktop harian |
| `npm run lint:desktop` | Menjalankan ESLint untuk frontend desktop |
| `npm run check:desktop` | Menjalankan pemeriksaan tipe TypeScript |
| `npm run build:desktop` | Membangun frontend assets |
| `npm run check:desktop-shell` | Memeriksa Tauri Rust backend |
| `npm run build:desktop-shell` | Membangun aplikasi Tauri penuh |
| `npm run build:bridge-service-native` | Membangun Rust Native Bridge Service |
| `npm run test:all` | Menjalankan full test entrypoint |
| `npm run test:contracts` | Memverifikasi frozen contracts |
| `npm run test:watch-mode-live:dry-run` | Menjalankan Watch Mode live-link dry-run |
| `npm run quality:gate:auto` | Menjalankan automated quality gate |
| `npm run quality:gate:release` | Menjalankan release quality gate |
| `npm run driver:build-sysvad` | Membangun SYSVAD virtual audio driver |
| `npm run driver:install` | Menginstal development driver |
| `npm run driver:test` | Memeriksa status development driver |
| `npm run driver:uninstall` | Menghapus development driver |
| `npm run release:prepare` | Menjalankan alur persiapan rilis |

## Arsitektur

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

## Struktur Direktori

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
├── crates/                         # Root Cargo workspace shared libraries
│   ├── omni-bridge-protocol/       # Pipe protocol shared by Desktop and Native Bridge
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

## Alur Inti

### Terjemahan Masuk (Skenario Watch / Subtitle)

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

### Terjemahan Keluar (Skenario Voice Room / Meeting / Game)

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

### Latensi dan Strategi Degradasi

- Subtitle dan dubbed speech adalah hasil penjadwalan yang terpisah; subtitle di-commit terlebih dahulu.
- Saat latensi provider melebihi budget, `latency-high` dipancarkan, subtitle tetap berjalan, dan TTS berpindah ke status deferred/queued.
- Saat provider probing menandai provider tidak cocok untuk real time, dubbed speech dinonaktifkan secara default dan jalur subtitle-first tetap aktif.
- Kegagalan Driver atau Bridge tidak memblokir startup aplikasi; subtitle, local playback, dan diagnostics harus tetap tersedia dalam mode degradasi.

## Tumpukan Teknologi

| Layer | Teknologi |
| --- | --- |
| Frontend | React 19.2.x, TypeScript 6.0.x, Vite 8.x, Rolldown, CSS |
| Desktop shell | Tauri 2.x, `@tauri-apps/api`, `@tauri-apps/cli` |
| State dan routing | Zustand 5.x, react-router-dom 7.x |
| Internationalization | i18next 26.x, react-i18next 17.x, i18next-browser-languagedetector |
| Frontend testing | Vitest 4.x, jsdom 29.x, ESLint 10.x |
| Rust runtime | Rust 2021, Serde, Tauri commands/events |
| Provider networking | reqwest 0.13, tungstenite 0.29, rustls |
| Storage dan credentials | rusqlite 0.40 bundled SQLite, keyring 4, Windows Credential Manager |
| Audio | cpal 0.17, rodio 0.22, wasapi 0.23, hound, minimp3 |
| System APIs | windows-sys 0.61 |
| Native Bridge | Rust sidecar, WASAPI, Named Pipe, IOCTL ABI |
| Driver | Windows SYSVAD WaveRT virtual audio driver |
| Scripts | PowerShell, Node.js release/testing scripts |

## Kontrak dan Batas Data

Proyek saat ini memelihara empat area frozen contract:

1. **Provider Contract**: Provider metadata, auth references, request parameters, streaming events, error structures, dan probe results.
2. **Audio Contract**: System audio, microphone, PCM frames, segments, mixing, latency compensation, dan push-to-talk state.
3. **Driver Bridge Contract**: Initialization, audio frames, state queries, error events, dan shutdown protocol di antara Desktop, Native Bridge, dan driver.
4. **OBS Integration Contract**: Connection dan output boundary yang disiapkan untuk dukungan OBS subtitle overlay dan scene trigger di masa mendatang.

Structured configuration menggunakan SQLite sebagai main source of truth. Sensitive credentials disimpan di Windows Credential Manager. Logs, caches, glossary packages, dan temporary audio files dipisahkan ke direktori masing-masing.

## Kualitas dan Pengujian

- `npm run verify:desktop`: lint, typecheck, test, dan build untuk frontend desktop.
- `npm run test:desktop-shell`: pengujian Tauri Rust backend.
- `npm run test:bridge-service-native`: pengujian Native Bridge Rust.
- `npm run test:contracts`: verifikasi frozen contract sisi TypeScript/Rust/script.
- `npm run quality:gate:auto`: automated quality gate.
- `npm run quality:gate:release`: release quality gate dengan manual verification entrypoints.
- `npm run test:watch-mode-report` / `npm run test:watch-mode-live:*`: Watch Mode reports, evidence, dan live-link test entrypoints.

## Pengembangan

### Pengembangan Frontend

Gunakan `npm run dev:desktop` untuk mengembangkan frontend di browser. Di lingkungan non-Tauri, runtime layer mengembalikan mock data sehingga halaman dan interaksi dapat diperiksa tanpa menginstal driver atau memulai Rust backend.

### Pengembangan dan Pengujian Desktop Shell

Untuk pekerjaan yang menyentuh `invoke`, event, SQLite, Windows Credential Manager, Native Bridge, audio sistem, atau subtitle overlay, pengujian wajib dilakukan di dalam desktop shell Tauri, tidak bisa digantikan dengan mock browser preview.

```powershell
# Saat pertama kali menjalankan, atau setelah mengubah Rust Core, Native Bridge, atau konfigurasi Cargo
npm run dev:desktop-shell

# Untuk pengembangan frontend/desktop harian setelah build standar berhasil sebelumnya
npm run dev:desktop:fast
```

`dev:desktop:fast` melewati rebuild release Native Bridge dan elevation UAC yang dijalankan `dev:desktop-shell`; skrip ini akan lebih dulu memulai dan melakukan prewarm server Vite di port `4173`, lalu masuk ke `tauri dev` sambil memakai ulang Cargo incremental cache. Debug EXE tidak dapat dijalankan langsung karena Tauri CLI juga menyediakan konteks runtime yang dibutuhkan WebView IPC. Tetap gunakan `dev:desktop-shell` saat menjalankan pertama kali, setelah perubahan source Native Bridge, atau saat perlu memverifikasi alur elevation.

Setelah desktop shell berjalan, verifikasi minimal sinyal berikut di halaman "Diagnostics":

- `isTauri`, `IPC Bridge`, `window.ipc`, dan `isTauriRuntime` semuanya bernilai `true`.
- Status bridge adalah `tauri-shell`, environment state ternormalisasi bukan `runtime-error`.
- Status storage `ready`, versi schema minimal `1`, dan credential backend bukan `browser-preview`.
- `artifacts/diagnostics/logs/app.log` menampilkan `debug_ipc_ping`, dan tidak ada `startup.ipc_watchdog_reload` setelah startup.

Hentikan proses pengembangan desktop sebelum menjalankan pemeriksaan Rust, agar `tauri dev` yang masih berjalan tidak menahan Cargo build lock dalam waktu lama:

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

### Pengembangan Driver

Membangun driver memerlukan Visual Studio 2022 + WDK. Menginstal development driver memerlukan hak administrator dan mode TESTSIGNING.

```bash
npm run driver:build-sysvad
npm run driver:install
npm run driver:test
npm run driver:uninstall
```

## Lisensi

Proyek ini menggunakan lisensi [Apache License 2.0](../LICENSE).
