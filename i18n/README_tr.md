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
        <a href="README_fil.md">Filipino</a> |
        <b>Türkçe</b>
    </p>
</h4>

Omni Translate, Windows için gerçek zamanlı ses çevirisine yönelik bir masaüstü uygulamasıdır. Video altyazısı çevirisi, oyunlarda ses çevirisi ve ses odaları ya da toplantılar için çift yönlü çeviri gibi iş akışlarını kapsar. Uygulama; sanal ses sürücüsünü, Native Bridge’i, Rust Core Runtime’ını ve birleşik AI Gateway’i birbirine bağlayarak sistem sesi yakalama, ASR, LLM çevirisi, TTS, altyazı işleme ve oynatma yönlendirmesini yürütür.

## Öne çıkan özellikler

- **Gerçek zamanlı altyazı çevirisi**: Sistem veya mikrofon sesini yakalar, konuşmayı gerçek zamanlı tanır ve çevrilmiş altyazıları ana pencerede ve yüzen pencerede gösterir.
- **Yüzen altyazı overlay’i**: Videoların, oyunların veya toplantı uygulamalarının üzerinde durmak üzere tasarlanmış, bağımsız, şeffaf, çerçevesiz ve her zaman üstte kalan pencere.
- **Çift yönlü ses çevirisi**: İzleme, oyun ve ses odası yönlendirme modlarını destekler; gelen altyazı/çeviri sesi ve giden sanal mikrofon çıkışını kapsar.
- **Sanal ses sürücüsü**: IOCTL ve paylaşılan ABI üzerinden kullanıcı modundaki bridge servisiyle iletişim kuran, SYSVAD WaveRT tabanlı Windows sanal ses sürücüsü.
- **Rust Native Bridge**: `apps/bridge-service-native`, şu anki tek üretim bridge uygulamasıdır; WASAPI, Named Pipe IPC, ses frame’leri ve sürücü etkileşimini yönetir.
- **Birleşik AI Gateway**: HTTP, streaming HTTP ve WebSocket taşıma biçimleriyle DashScope ve OpenAI uyumlu arayüzlere template tabanlı entegrasyon sağlar.
- **Sözlük yönetimi**: Alan sözlüğü paketlerinin içe aktarılmasını, dışa aktarılmasını, birleştirilmesini ve önceliklendirme politikalarını destekler; ardından bunları çeviri prompt zincirine ekler.
- **Güvenli kimlik bilgisi yönetimi**: API anahtarları gibi hassas bilgiler, iş yapılandırmasına düz metin olarak yazılmak yerine Windows Credential Manager içinde saklanır.
- **Tanılama ve quality gate’ler**: Sürücü sağlık sondaları, model trace’leri, log dışa aktarma, Watch Mode gerçek bağlantı testleri ve release öncesi quality gate’ler sunar.
- **20 UI dili**: Geçerli arayüz dili kaynakları `ar`, `bn`, `de`, `en`, `es`, `fil`, `fr`, `hi`, `id`, `ja`, `ko`, `mr`, `pt`, `ru`, `ta`, `te`, `th`, `tr`, `vi` ve `zh-CN` dillerini kapsar.

## Hızlı başlangıç

### Gereksinimler

- **Node.js** >= 20
- **Rust stable**, edition 2021
- **Windows 10/11**
- **Visual Studio 2022 Build Tools + Desktop development with C++**, Tauri desktop shell ve Native Bridge derlenirken gereklidir; komut satırında `cl.exe` ve `link.exe` bulunabilmelidir
- **WDK 10.0.26100**, yalnızca sanal ses sürücüsünü derlemek için gereklidir
- Geliştirme sürücülerini yüklemek Windows TESTSIGNING modunu gerektirir; normal frontend önizlemesi sürücü veya yönetici yetkisi gerektirmez

### Kurulum ve çalıştırma

```bash
# 1. Depoyu klonla
git clone <repo-url>
cd omni-translate

# 2. package-lock.json'a göre bağımlılıkları kur
npm ci

# 3. Frontend tarayıcı önizlemesini başlat
npm run dev:desktop

# 4. Tam Tauri masaüstü uygulamasını başlat
npm run dev:desktop-shell
```

Tarayıcı önizleme modu otomatik olarak mock runtime kullanır; UI geliştirme ve sayfa kontrolü için uygundur. Tam masaüstü uygulaması Tauri/Rust runtime’ını başlatır ve yalnızca sürücü kurulumu veya onarımı gibi işlemler söz konusu olduğunda yetki yükseltme akışını tetikler.

Tam masaüstü kabuğunu ilk kez başlatmadan önce, depoya Visual Studio 2022’nin **Developer PowerShell** veya **x64 Native Tools Command Prompt**’u üzerinden girmeniz önerilir. Normal PowerShell `link.exe not found` hatası verirse, önce MSVC ortamını yükleyebilirsiniz:

```powershell
& "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\Launch-VsDevShell.ps1" -Arch amd64 -HostArch amd64
npm run dev:desktop-shell
```

`dev:desktop-shell`, önce release sürümü Native Bridge’i derler, ardından Tauri dev üzerinden Vite, Rust Core ve masaüstü penceresini başlatır; betik UAC ister. İlk Rust derlemesi bağımlılıkları indirip derlemesi gerektiğinden, sonraki başlatmalardan belirgin şekilde daha uzun sürer.

### Yaygın komutlar

| Komut | Açıklama |
| --- | --- |
| `npm run dev:desktop` | React/Vite frontend geliştirme sunucusunu başlatır |
| `npm run dev:desktop-shell` | Yetki yükseltme betiği üzerinden tam Tauri masaüstü uygulamasını başlatır |
| `npm run dev:desktop:fast` | Release Native Bridge yeniden derlemesini ve yetki yükseltmeyi atlar, günlük masaüstü geliştirmesi için Cargo artımlı önbelleğini yeniden kullanır |
| `npm run lint:desktop` | Desktop frontend için ESLint çalıştırır |
| `npm run check:desktop` | TypeScript tip denetimi çalıştırır |
| `npm run build:desktop` | Frontend çıktıları derler |
| `npm run check:desktop-shell` | Tauri Rust backend’i denetler |
| `npm run build:desktop-shell` | Tam Tauri uygulamasını derler |
| `npm run build:bridge-service-native` | Rust Native Bridge Service’i derler |
| `npm run test:all` | Tüm test giriş noktasını çalıştırır |
| `npm run test:contracts` | Dondurulmuş contract’ları doğrular |
| `npm run test:watch-mode-live:dry-run` | Watch Mode gerçek bağlantı dry-run çalıştırır |
| `npm run quality:gate:auto` | Otomatik quality gate’i çalıştırır |
| `npm run quality:gate:release` | Release öncesi quality gate’i çalıştırır |
| `npm run driver:build-sysvad` | SYSVAD sanal ses sürücüsünü derler |
| `npm run driver:install` | Geliştirme sürücüsünü kurar |
| `npm run driver:test` | Geliştirme sürücüsü durumunu sondalar |
| `npm run driver:uninstall` | Geliştirme sürücüsünü kaldırır |
| `npm run release:prepare` | Release hazırlık pipeline’ını çalıştırır |

## Sistem mimarisi

```text
┌────────────────────────────────────────────────────────────┐
│ 1. Desktop Shell                                            │
│    Tauri 2 + React 19 + TypeScript 6 + Vite 8/Rolldown      │
│    Ana pencere, altyazı overlay’i, yönlendirme, ayarlar,    │
│    tanılama, provider sayfaları                             │
├────────────────────────────────────────────────────────────┤
│ 2. Rust Core Runtime                                        │
│    Tauri commands/events, oturum orkestrasyonu, depolama,   │
│    tanılama, tray entegrasyonu                              │
├────────────────────────────────────────────────────────────┤
│ 3. Audio Layer                                              │
│    WASAPI + cpal + rodio, sistem/mikrofon yakalama, VAD,    │
│    segmentasyon, miksleme                                   │
├────────────────────────────────────────────────────────────┤
│ 4. AI Gateway                                               │
│    reqwest + tungstenite, ASR / Translation / TTS provider’ları│
│    DashScope ve OpenAI uyumlu template’ler, sondalar, hatalar│
├────────────────────────────────────────────────────────────┤
│ 5. Native Bridge Service                                    │
│    Rust sidecar, WASAPI, Named Pipe IPC, ses frame’leri,    │
│    sürücü IOCTL                                             │
├────────────────────────────────────────────────────────────┤
│ 6. Driver / Installer                                       │
│    SYSVAD WaveRT sanal ses sürücüsü, kurulum, rollback,     │
│    onarım, sağlık sondası                                   │
└────────────────────────────────────────────────────────────┘
```

## Dizin yapısı

```text
omni-translate/
├── apps/
│   ├── desktop/                    # Tauri masaüstü uygulaması
│   │   ├── src/                    # React frontend
│   │   │   ├── components/         # Ortak UI bileşenleri
│   │   │   ├── i18n/               # 20 UI dili kaynağı
│   │   │   ├── pages/              # Oturum, yönlendirme, provider, sözlük, ayarlar, tanılama sayfaları
│   │   │   ├── runtime/            # Frontend runtime/IPC adaptörleri
│   │   │   ├── schema/             # TypeScript contract’ları ve tipleri
│   │   │   └── stores/             # Zustand durumu
│   │   └── src-tauri/              # Rust desktop shell
│   │       └── src/
│   │           ├── audio/          # Ses motoru, STT, TTS, çeviri yönlendirme, gerçek zamanlı provider’lar
│   │           ├── bridge/         # Bridge/sürücü kurulumu ve IPC contract’ları
│   │           ├── diagnostics/    # Loglar, trace’ler, tanılama durumu
│   │           ├── provider/       # AI Gateway, provider template’leri, HTTP/WS taşıması
│   │           ├── runtime/        # Pencereler, tray, runtime durumu
│   │           └── storage/        # SQLite deposu ve kimlik bilgisi yönetimi
│   └── bridge-service-native/      # Rust Native Bridge Service, tek üretim bridge uygulaması
├── crates/                         # Kök Cargo workspace'in paylaşılan kütüphaneleri
│   ├── omni-bridge-protocol/       # Desktop ve Native Bridge arasında paylaşılan pipe protokolü
│   └── omni-logging/               # Paylaşılan, engellemeyen (non-blocking) loglama hattı
├── drivers/
│   └── windows-virtual-mic/        # SYSVAD WaveRT sanal ses sürücüsü
│       ├── include/                # Paylaşılan Driver/Bridge IOCTL ABI
│       ├── package/                # Sürücü paketi metadata’sı
│       └── sysvad/                 # Microsoft SYSVAD örneğinden uyarlanmış sürücü kaynak kodu
├── scripts/
│   ├── development/                # Geliştirme başlatma betikleri
│   ├── diagnostics/                # Tanılama araçları
│   ├── installer/                  # Sürücü derleme, kurulum, kaldırma, onarım, sondalama
│   ├── release/                    # Release doğrulama, manifest, paketleme, imza manifest’i
│   └── testing/                    # Testler, coverage, quality gate’ler, Watch Mode bağlantıları
├── docs/                           # Mimari, kalite, proje dokümanları ve provider/API referansları
└── artifacts/                      # Derleme çıktıları, loglar ve tanılama çıktıları
```

## Temel akışlar

### Gelen çeviri (izleme/altyazı senaryoları)

```text
Sistem sesi
  → Sanal ses sürücüsü / WASAPI yakalama
  → Native Bridge Service
  → Desktop Rust Audio Layer
  → VAD / segmentasyon
  → ASR
  → Translation Provider
  → Altyazı işleme (ana pencere + overlay)
  → İsteğe bağlı TTS
  → Yerel hoparlör / izleme çıkışı
```

### Giden çeviri (ses odası/toplantı/oyun senaryoları)

```text
Mikrofon
  → Desktop Rust Audio Layer
  → VAD / segmentasyon
  → ASR
  → Translation Provider
  → TTS
  → Native Bridge Service
  → Sanal ses sürücüsü
  → Hedef uygulama sanal mikrofonu / sanal endpoint’i okur
```

### Gecikme ve degrade modlar

- Altyazılar ve dublaj sesi ayrı zamanlama sonuçlarıdır; altyazılar önce commit edilir.
- Provider gecikmesi bütçeyi aştığında `latency-high` üretilir, altyazılar devam eder ve TTS deferred/queued durumuna geçer.
- Provider sondası bir provider’ı gerçek zaman için uygun değil olarak işaretlediğinde dublaj sesi varsayılan olarak kapatılır ve altyazı öncelikli yol aktif kalır.
- Sürücü veya Bridge arızaları uygulamanın başlamasını engellemez; altyazılar, yerel oynatma ve tanılama sayfası degrade modda kullanılabilir kalmalıdır.

## Teknoloji yığını

| Katman | Teknoloji |
| --- | --- |
| Frontend | React 19.2.x, TypeScript 6.0.x, Vite 8.x, Rolldown, CSS |
| Desktop shell | Tauri 2.x, `@tauri-apps/api`, `@tauri-apps/cli` |
| Durum ve yönlendirme | Zustand 5.x, react-router-dom 7.x |
| Uluslararasılaştırma | i18next 26.x, react-i18next 17.x, i18next-browser-languagedetector |
| Frontend testleri | Vitest 4.x, jsdom 29.x, ESLint 10.x |
| Rust runtime | Rust 2021, Serde, Tauri commands/events |
| Provider ağı | reqwest 0.13, tungstenite 0.29, rustls |
| Depolama ve kimlik bilgileri | rusqlite 0.40 bundled SQLite, Windows Credential Manager |
| Ses | cpal 0.17, rodio 0.22, wasapi 0.23, hound |
| Sistem API’leri | windows-sys 0.61 |
| Native Bridge | Rust sidecar, WASAPI, Named Pipe, IOCTL ABI |
| Sürücü | Windows SYSVAD WaveRT sanal ses sürücüsü |
| Betikler | PowerShell, release ve test için Node.js betikleri |

## Sözleşmeler ve veri sınırları

Proje şu anda dört dondurulmuş sözleşme alanını korur:

1. **Provider Contract**: Provider metadata’sı, auth referansları, istek parametreleri, streaming event’leri, hata yapıları ve sonda sonuçları.
2. **Audio Contract**: Sistem sesi, mikrofon, PCM frame’leri, segmentler, miksleme, gecikme telafisi ve push-to-talk durumu.
3. **Driver Bridge Contract**: Desktop, Native Bridge ve sürücü arasındaki başlatma, ses frame’leri, durum sorguları, hata event’leri ve kapatma protokolü.
4. **OBS Integration Contract**: Gelecekteki OBS altyazı overlay’i ve sahne tetikleme desteği için ayrılmış bağlantı ve çıktı sınırı.

Yapılandırılmış konfigürasyon ana doğruluk kaynağı olarak SQLite kullanır. Hassas kimlik bilgileri Windows Credential Manager içinde saklanır. Loglar, cache’ler, sözlük paketleri ve geçici ses dosyaları ayrı dizinlerde tutulur.

## Kalite ve test

- `npm run verify:desktop`: desktop frontend lint, typecheck, test ve build.
- `npm run test:desktop-shell`: Tauri Rust backend testleri.
- `npm run test:bridge-service-native`: Native Bridge Rust testleri.
- `npm run test:contracts`: TypeScript/Rust/betik tarafındaki dondurulmuş sözleşme doğrulaması.
- `npm run quality:gate:auto`: otomatik quality gate.
- `npm run quality:gate:release`: manuel doğrulama giriş noktaları içeren release öncesi quality gate.
- `npm run test:watch-mode-report` / `npm run test:watch-mode-live:*`: Watch Mode raporları, kanıtları ve gerçek bağlantı test giriş noktaları.

## Geliştirme

### Frontend geliştirme

Frontend’i doğrudan tarayıcıda geliştirmek için `npm run dev:desktop` kullanılabilir. Tauri olmayan ortamlarda runtime katmanı mock veri döndürür; böylece sürücü kurmadan veya Rust backend’i başlatmadan sayfalar ve etkileşimler kontrol edilebilir.

### Masaüstü kabuğu geliştirme ve testi

`invoke`, event, SQLite, Windows Credential Manager, Native Bridge, sistem sesi veya altyazı overlay’i ile ilgili çalışmalarda mutlaka Tauri masaüstü kabuğunda test edilmelidir; tarayıcı mock önizlemesi bunun yerini tutamaz.

```powershell
# İlk başlatmada veya Rust Core, Native Bridge, Cargo yapılandırmasında değişiklik yapıldığında
npm run dev:desktop-shell

# Standart derleme başarıyla tamamlandıktan sonraki günlük frontend/masaüstü geliştirmesi
npm run dev:desktop:fast
```

`dev:desktop:fast`, `dev:desktop-shell`'in yaptığı release Native Bridge yeniden derlemesini ve UAC yetki yükseltmesini atlar: önce `4173` portundaki Vite servisini önceden başlatıp ısıtır, ardından `tauri dev`'e geçerek Cargo artımlı önbelleğini yeniden kullanır. Debug EXE doğrudan çalıştırılamaz, çünkü WebView IPC için gereken çalışma zamanı bağlamını hâlâ Tauri CLI sağlar. İlk çalıştırmada, Native Bridge kaynak kodu değiştiğinde veya yetki yükseltme akışının doğrulanması gerektiğinde yine de `dev:desktop-shell` kullanılmalıdır.

Masaüstü kabuğu başladıktan sonra, "Tanılama" sayfasında en azından şu sinyaller doğrulanmalıdır:

- `isTauri`, `IPC Bridge`, `window.ipc` ve `isTauriRuntime` hepsi `true` olmalıdır.
- Bridge durumu `tauri-shell` olmalı, normalize edilmiş ortam durumu `runtime-error` olmamalıdır.
- Depolama durumu `ready` olmalı, şema sürümü en az `1` olmalı, kimlik bilgisi backend’i `browser-preview` olmamalıdır.
- `artifacts/diagnostics/logs/app.log` dosyasında `debug_ipc_ping` görülmeli ve başlatmadan sonra `startup.ipc_watchdog_reload` görülmemelidir.

Cargo build kilidinin çalışan `tauri dev` tarafından uzun süre tutulmasını önlemek için, Rust denetimlerini çalıştırmadan önce masaüstü geliştirme sürecini sonlandırın:

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

### Sürücü geliştirme

Sürücüyü derlemek için Visual Studio 2022 + WDK gerekir. Geliştirme sürücüsünü kurmak yönetici yetkisi ve TESTSIGNING modu gerektirir.

```bash
npm run driver:build-sysvad
npm run driver:install
npm run driver:test
npm run driver:uninstall
```

## Lisans

Bu proje [Apache License 2.0](../LICENSE) lisansı ile lisanslanmıştır.
