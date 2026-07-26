# Omni Translate

<h4 align="center">
    <p>
        <a href="../README.md">简体中文</a> |
        <a href="README_en.md">English</a> |
        <a href="README_es.md">Español</a> |
        <a href="README_ar.md">العربية</a> |
        <a href="README_pt.md">Português</a> |
        <b>Русский</b> |
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

Omni Translate — настольное приложение Windows для перевода аудио в реальном времени, охватывающее такие сценарии, как перевод субтитров к видео, голосовой перевод в играх, а также двусторонний перевод в голосовых комнатах и на встречах. Приложение связывает виртуальный аудиодрайвер, Native Bridge, Rust Core Runtime и единый AI Gateway, чтобы обеспечить захват системного звука, ASR, перевод через LLM, TTS, рендеринг субтитров и маршрутизацию воспроизведения.

## Возможности

- **Перевод субтитров в реальном времени**: Захватывает системный звук или звук микрофона, распознает речь в реальном времени и отображает переведенные субтитры в основном окне и плавающем оверлее.
- **Плавающий оверлей субтитров**: Отдельное прозрачное окно без рамки, которое всегда поверх других окон и предназначено для размещения поверх видео, игр или приложений для встреч.
- **Двусторонний голосовой перевод**: Поддерживает режимы маршрутизации для просмотра, игр и голосовых комнат, охватывая входящие субтитры/переведенную речь и исходящий вывод virtual microphone.
- **Виртуальный аудиодрайвер**: Виртуальный аудиодрайвер Windows на базе SYSVAD WaveRT, связанный со службой-мостом в user mode через IOCTL и shared ABI.
- **Rust Native Bridge**: `apps/bridge-service-native` — единственная на данный момент production-реализация bridge, отвечающая за WASAPI, Named Pipe IPC, audio frames и взаимодействие с драйвером.
- **Единый AI Gateway**: Шаблонная интеграция с DashScope и OpenAI-совместимыми интерфейсами с поддержкой транспортов HTTP, streaming HTTP и WebSocket.
- **Управление glossary**: Поддерживает импорт, экспорт, объединение и приоритизацию domain glossary packages, а затем внедряет их в translation prompt flow.
- **Безопасное хранение учетных данных**: API keys и другие чувствительные данные хранятся в Windows Credential Manager, а не записываются в открытом виде в конфигурацию.
- **Диагностика и quality gates**: Driver health probes, model traces, экспорт логов, Watch Mode live-link тесты и quality gates перед релизом.
- **20 языков интерфейса**: Текущие locale resources охватывают `ar`, `bn`, `de`, `en`, `es`, `fil`, `fr`, `hi`, `id`, `ja`, `ko`, `mr`, `pt`, `ru`, `ta`, `te`, `th`, `tr`, `vi` и `zh-CN`.

## Быстрый Старт

### Требования

- **Node.js** >= 20
- **Rust stable**, edition 2021
- **Windows 10/11**
- **Visual Studio 2022 Build Tools + Desktop development with C++**, требуется для сборки Tauri desktop shell и Native Bridge; в командной строке должны быть доступны `cl.exe` и `link.exe`
- **WDK 10.0.26100**, требуется только для сборки virtual audio driver
- Загрузка development drivers требует режима Windows TESTSIGNING; обычный frontend preview не требует драйвера или прав администратора

### Установка и Запуск

```bash
# 1. Клонировать репозиторий
git clone <repo-url>
cd omni-translate

# 2. Установить зависимости по package-lock.json
npm ci

# 3. Запустить frontend browser preview
npm run dev:desktop

# 4. Запустить полное Tauri desktop app
npm run dev:desktop-shell
```

Режим browser preview автоматически использует mock runtime, поэтому подходит для разработки UI и проверки страниц. Полное desktop-приложение запускает Tauri/Rust runtime и запрашивает elevation только при действиях, связанных с установкой или восстановлением драйвера.

Перед первым запуском полной desktop shell рекомендуется открывать репозиторий из **Developer PowerShell** или **x64 Native Tools Command Prompt** Visual Studio 2022. Если обычный PowerShell сообщает `link.exe not found`, можно предварительно загрузить окружение MSVC:

```powershell
& "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\Launch-VsDevShell.ps1" -Arch amd64 -HostArch amd64
npm run dev:desktop-shell
```

`dev:desktop-shell` сначала собирает release-версию Native Bridge, а затем запускает Vite, Rust Core и desktop-окно через Tauri dev; скрипт запрашивает UAC. Первая сборка Rust требует загрузки и компиляции зависимостей, поэтому она заметно дольше последующих запусков.

### Основные Команды

| Команда | Описание |
| --- | --- |
| `npm run dev:desktop` | Запустить React/Vite frontend dev server |
| `npm run dev:desktop-shell` | Запустить полное Tauri desktop app через elevation script |
| `npm run dev:desktop:fast` | Пропустить пересборку release Native Bridge и elevation, использовать Cargo incremental cache для ежедневной desktop-разработки |
| `npm run lint:desktop` | Запустить ESLint для desktop frontend |
| `npm run check:desktop` | Выполнить TypeScript type checking |
| `npm run build:desktop` | Собрать frontend assets |
| `npm run check:desktop-shell` | Проверить Tauri Rust backend |
| `npm run build:desktop-shell` | Собрать полное Tauri app |
| `npm run build:bridge-service-native` | Собрать Rust Native Bridge Service |
| `npm run test:all` | Запустить full test entrypoint |
| `npm run test:contracts` | Проверить frozen contracts |
| `npm run test:watch-mode-live:dry-run` | Запустить Watch Mode live-link dry-run |
| `npm run quality:gate:auto` | Запустить automated quality gate |
| `npm run quality:gate:release` | Запустить release quality gate |
| `npm run driver:build-sysvad` | Собрать SYSVAD virtual audio driver |
| `npm run driver:install` | Установить development driver |
| `npm run driver:test` | Проверить status development driver |
| `npm run driver:uninstall` | Удалить development driver |
| `npm run release:prepare` | Запустить конвейер подготовки релиза |

## Архитектура

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

## Структура Каталогов

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
├── crates/                         # Общие библиотеки корневого Cargo workspace
│   ├── omni-bridge-protocol/       # Общий протокол канала (pipe) между Desktop и Native Bridge
│   └── omni-logging/               # Общий неблокирующий конвейер логирования
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

## Основные Потоки

### Входящий Перевод (Сценарии Watch / Subtitle)

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

### Исходящий Перевод (Сценарии Voice Room / Meeting / Game)

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

### Задержка и Режимы Деградации

- Субтитры и dubbed speech являются отдельными результатами планирования; сначала фиксируются субтитры.
- Когда provider latency превышает budget, испускается `latency-high`, субтитры продолжают выводиться, а TTS переходит в состояние deferred/queued.
- Когда provider probing помечает provider как непригодный для real time, dubbed speech по умолчанию отключается, а subtitle-first path остается активным.
- Сбои Driver или Bridge не блокируют запуск приложения; subtitles, local playback и страница diagnostics должны оставаться доступными в degraded mode.

## Технологический Стек

| Слой | Технология |
| --- | --- |
| Frontend | React 19.2.x, TypeScript 6.0.x, Vite 8.x, Rolldown, CSS |
| Desktop shell | Tauri 2.x, `@tauri-apps/api`, `@tauri-apps/cli` |
| State и routing | Zustand 5.x, react-router-dom 7.x |
| Internationalization | i18next 26.x, react-i18next 17.x, i18next-browser-languagedetector |
| Frontend testing | Vitest 4.x, jsdom 29.x, ESLint 10.x |
| Rust runtime | Rust 2021, Serde, Tauri commands/events |
| Provider networking | reqwest 0.13, tungstenite 0.29, rustls |
| Storage и credentials | rusqlite 0.40 bundled SQLite, keyring 4, Windows Credential Manager |
| Audio | cpal 0.17, rodio 0.22, wasapi 0.23, hound, minimp3 |
| System APIs | windows-sys 0.61 |
| Native Bridge | Rust sidecar, WASAPI, Named Pipe, IOCTL ABI |
| Driver | Windows SYSVAD WaveRT virtual audio driver |
| Scripts | PowerShell, Node.js release/testing scripts |

## Контракты и Границы Данных

Проект сейчас поддерживает четыре области frozen contract:

1. **Provider Contract**: Provider metadata, auth references, request parameters, streaming events, error structures и probe results.
2. **Audio Contract**: System audio, microphone, PCM frames, segments, mixing, latency compensation и push-to-talk state.
3. **Driver Bridge Contract**: Initialization, audio frames, state queries, error events и shutdown protocol между Desktop, Native Bridge и driver.
4. **OBS Integration Contract**: Зарезервированная connection и output boundary для будущей поддержки OBS subtitle overlay и scene trigger.

Structured configuration использует SQLite как main source of truth. Sensitive credentials хранятся в Windows Credential Manager. Logs, caches, glossary packages и temporary audio files размещаются в отдельных каталогах.

## Качество и Тестирование

- `npm run verify:desktop`: lint, typecheck, test и build для desktop frontend.
- `npm run test:desktop-shell`: тесты Tauri Rust backend.
- `npm run test:bridge-service-native`: тесты Native Bridge Rust.
- `npm run test:contracts`: проверка frozen contract на стороне TypeScript/Rust/script.
- `npm run quality:gate:auto`: automated quality gate.
- `npm run quality:gate:release`: release quality gate с manual verification entrypoints.
- `npm run test:watch-mode-report` / `npm run test:watch-mode-live:*`: Watch Mode reports, evidence и live-link test entrypoints.

## Разработка

### Разработка Frontend

Используйте `npm run dev:desktop` для разработки frontend в браузере. В средах non-Tauri runtime layer возвращает mock data, поэтому страницы и взаимодействия можно проверять без установки драйвера или запуска Rust backend.

### Разработка и Тестирование Desktop Shell

При работе с `invoke`, event, SQLite, Windows Credential Manager, Native Bridge, системным звуком или subtitle overlay тестирование обязательно должно проводиться в Tauri desktop shell — browser mock preview для этого не подходит.

```powershell
# При первом запуске или после изменений в Rust Core, Native Bridge, конфигурации Cargo
npm run dev:desktop-shell

# Ежедневная разработка frontend/desktop после уже успешно выполненной стандартной сборки
npm run dev:desktop:fast
```

`dev:desktop:fast` пропускает пересборку release Native Bridge и UAC elevation, которые выполняет `dev:desktop-shell`: сначала он запускает и прогревает Vite service на порту `4173`, затем переходит в `tauri dev` с переиспользованием Cargo incremental cache. Debug EXE нельзя запускать напрямую, поскольку Tauri CLI по-прежнему отвечает за runtime context, необходимый для WebView IPC. При первом запуске, после изменений исходного кода Native Bridge или при необходимости проверить elevation flow, следует по-прежнему использовать `dev:desktop-shell`.

После запуска desktop shell на странице «Диагностика» нужно как минимум подтвердить следующие сигналы:

- `isTauri`, `IPC Bridge`, `window.ipc` и `isTauriRuntime` равны `true`.
- Bridge status — `tauri-shell`, нормализованное состояние environment не `runtime-error`.
- Storage status — `ready`, версия schema не ниже `1`, credential backend не `browser-preview`.
- В `artifacts/diagnostics/logs/app.log` появляется `debug_ipc_ping`, и после запуска отсутствует `startup.ipc_watchdog_reload`.

Перед запуском Rust-проверок завершите процесс desktop-разработки, чтобы работающий `tauri dev` не удерживал долго Cargo build lock:

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

### Разработка Driver

Для сборки driver требуется Visual Studio 2022 + WDK. Для установки development driver нужны права администратора и режим TESTSIGNING.

```bash
npm run driver:build-sysvad
npm run driver:install
npm run driver:test
npm run driver:uninstall
```

## Лицензия

Проект распространяется по лицензии [Apache License 2.0](../LICENSE).
