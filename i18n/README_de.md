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
        <b>Deutsch</b> |
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

Omni Translate ist eine Windows-Desktopanwendung für Audioübersetzung in Echtzeit. Sie deckt Workflows wie Videountertitel-Übersetzung, Sprachübersetzung in Spielen und bidirektionale Übersetzung für Sprachräume oder Meetings ab. Die App verbindet einen virtuellen Audiotreiber, die Native Bridge, die Rust Core Runtime und ein einheitliches AI Gateway, um Audioerfassung, ASR, LLM-Übersetzung, TTS, Untertitel-Rendering und Wiedergaberouting zu verarbeiten.

## Funktionen

- **Untertitelübersetzung in Echtzeit**: Erfasst System- oder Mikrofon-Audio, erkennt Sprache in Echtzeit und zeigt übersetzte Untertitel im Hauptfenster und im Overlay an.
- **Schwebendes Untertitel-Overlay**: Ein eigenständiges, transparentes, rahmenloses und immer im Vordergrund bleibendes Fenster, das über Videos, Spielen oder Meeting-Apps liegen kann.
- **Bidirektionale Sprachübersetzung**: Unterstützt Routing-Modi für Anschauen, Spiele und Sprachräume und deckt eingehende Untertitel/Sprachausgabe sowie ausgehende virtuelle Mikrofon-Ausgabe ab.
- **Virtueller Audiotreiber**: Windows-virtueller Audiotreiber auf Basis von SYSVAD WaveRT, der über IOCTL und eine gemeinsame ABI mit dem Bridge-Dienst im Benutzermodus kommuniziert.
- **Rust Native Bridge**: `apps/bridge-service-native` ist derzeit die einzige produktive Bridge-Implementierung und verarbeitet WASAPI, Named Pipe IPC, Audioframes und die Treiberkommunikation.
- **Einheitliches AI Gateway**: Vorlagenbasierte Integration von DashScope und OpenAI-kompatiblen Schnittstellen mit Unterstützung für HTTP-, Streaming-HTTP- und WebSocket-Transporte.
- **Glossarverwaltung**: Unterstützt Import, Export, Zusammenführung und Priorisierung domänenspezifischer Glossarpakete und speist sie in die Übersetzungs-Prompt-Kette ein.
- **Sichere Verwaltung von Zugangsdaten**: API-Schlüssel und andere sensible Informationen werden im Windows Credential Manager gespeichert statt im Klartext in die Geschäftskonfiguration geschrieben zu werden.
- **Diagnose und Quality Gates**: Bietet Treiber-Health-Probes, Modell-Traces, Logexport, Watch-Mode-Live-Link-Tests und Quality Gates vor dem Release.
- **20 UI-Sprachen**: Die aktuellen Locale-Ressourcen decken `ar`, `bn`, `de`, `en`, `es`, `fil`, `fr`, `hi`, `id`, `ja`, `ko`, `mr`, `pt`, `ru`, `ta`, `te`, `th`, `tr`, `vi` und `zh-CN` ab.

## Schnellstart

### Voraussetzungen

- **Node.js** >= 20
- **Rust stable**, Edition 2021
- **Windows 10/11**
- **Visual Studio 2022 Build Tools + Desktop development with C++**, erforderlich zum Kompilieren der Tauri-Desktop-Shell und der Native Bridge; `cl.exe` und `link.exe` müssen über die Kommandozeile auffindbar sein
- **WDK 10.0.26100**, nur zum Kompilieren des virtuellen Audiotreibers erforderlich
- Das Laden von Entwicklungstreibern erfordert den Windows-TESTSIGNING-Modus; die normale Frontend-Vorschau benötigt weder Treiber noch Administratorrechte

### Installation und Start

```bash
# 1. Repository klonen
git clone <repo-url>
cd omni-translate

# 2. Abhängigkeiten gemäß package-lock.json installieren
npm ci

# 3. Frontend-Browser-Vorschau starten
npm run dev:desktop

# 4. Vollständige Tauri-Desktop-App starten
npm run dev:desktop-shell
```

Der Browser-Vorschaumodus verwendet automatisch die Mock-Runtime und eignet sich für UI-Entwicklung und Seitenprüfungen. Die vollständige Desktop-App startet die Tauri/Rust-Runtime und löst nur bei Aktionen wie Treiberinstallation oder -reparatur eine Rechteerhöhung aus.

Bevor Sie die vollständige Desktop-Shell zum ersten Mal starten, wird empfohlen, das Repository aus der **Developer PowerShell** oder der **x64 Native Tools Command Prompt** von Visual Studio 2022 heraus zu öffnen. Meldet eine normale PowerShell `link.exe not found`, kann zunächst die MSVC-Umgebung geladen werden:

```powershell
& "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\Launch-VsDevShell.ps1" -Arch amd64 -HostArch amd64
npm run dev:desktop-shell
```

`dev:desktop-shell` erstellt zunächst eine Release-Version der Native Bridge und startet dann über Tauri dev Vite, die Rust Core und das Desktop-Fenster; das Skript fordert eine UAC-Bestätigung an. Der erste Rust-Build muss Abhängigkeiten herunterladen und kompilieren, was deutlich länger dauert als spätere Starts.

### Häufige Befehle

| Befehl | Beschreibung |
| --- | --- |
| `npm run dev:desktop` | Startet den React/Vite-Frontend-Entwicklungsserver |
| `npm run dev:desktop-shell` | Startet die vollständige Tauri-Desktop-App über das Skript zur Rechteerhöhung |
| `npm run dev:desktop:fast` | Überspringt den Release-Rebuild der Native Bridge und die Rechteerhöhung, nutzt den Cargo-Inkrementell-Cache für die tägliche Desktop-Abstimmung |
| `npm run lint:desktop` | Führt ESLint für das Desktop-Frontend aus |
| `npm run check:desktop` | Führt die TypeScript-Typprüfung aus |
| `npm run build:desktop` | Erstellt die Frontend-Artefakte |
| `npm run check:desktop-shell` | Prüft das Tauri-Rust-Backend |
| `npm run build:desktop-shell` | Erstellt die vollständige Tauri-App |
| `npm run build:bridge-service-native` | Erstellt den Rust Native Bridge Service |
| `npm run test:all` | Führt den vollständigen Test-Einstiegspunkt aus |
| `npm run test:contracts` | Prüft eingefrorene Verträge |
| `npm run test:watch-mode-live:dry-run` | Führt den Watch-Mode-Live-Link-Dry-Run aus |
| `npm run quality:gate:auto` | Führt das automatisierte Quality Gate aus |
| `npm run quality:gate:release` | Führt das Release-Quality-Gate aus |
| `npm run driver:build-sysvad` | Erstellt den virtuellen SYSVAD-Audiotreiber |
| `npm run driver:install` | Installiert den Entwicklungstreiber |
| `npm run driver:test` | Prüft den Status des Entwicklungstreibers |
| `npm run driver:uninstall` | Deinstalliert den Entwicklungstreiber |
| `npm run release:prepare` | Führt die Release-Vorbereitungspipeline aus |

## Systemarchitektur

```text
┌────────────────────────────────────────────────────────────┐
│ 1. Desktop Shell                                            │
│    Tauri 2 + React 19 + TypeScript 6 + Vite 8/Rolldown      │
│    Hauptfenster, Untertitel-Overlay, Routing, Einstellungen,│
│    Diagnose, Provider-Seiten                                │
├────────────────────────────────────────────────────────────┤
│ 2. Rust Core Runtime                                        │
│    Tauri commands/events, Sitzungsorchestrierung, Speicher,  │
│    Diagnose, Tray-Integration                               │
├────────────────────────────────────────────────────────────┤
│ 3. Audio Layer                                              │
│    WASAPI + cpal + rodio, System-/Mikrofonerfassung, VAD,   │
│    Segmentierung, Mischung                                  │
├────────────────────────────────────────────────────────────┤
│ 4. AI Gateway                                               │
│    reqwest + tungstenite, ASR- / Translation- / TTS-Provider │
│    DashScope- und OpenAI-kompatible Vorlagen, Probes, Fehler │
├────────────────────────────────────────────────────────────┤
│ 5. Native Bridge Service                                    │
│    Rust sidecar, WASAPI, Named Pipe IPC, Audioframes,        │
│    Treiber-IOCTL                                            │
├────────────────────────────────────────────────────────────┤
│ 6. Driver / Installer                                       │
│    SYSVAD WaveRT virtueller Audiotreiber, Installation,      │
│    Rollback, Reparatur, Health-Probing                      │
└────────────────────────────────────────────────────────────┘
```

## Verzeichnisstruktur

```text
omni-translate/
├── apps/
│   ├── desktop/                    # Tauri-Desktopanwendung
│   │   ├── src/                    # React-Frontend
│   │   │   ├── components/         # Gemeinsame UI-Komponenten
│   │   │   ├── i18n/               # UI-Locale-Ressourcen für 20 Sprachen
│   │   │   ├── pages/              # Seiten für Sitzung, Routing, Provider, Glossar, Einstellungen und Diagnose
│   │   │   ├── runtime/            # Frontend-runtime/IPC-Adapter
│   │   │   ├── schema/             # TypeScript-Verträge und Typen
│   │   │   └── stores/             # Zustand-State
│   │   └── src-tauri/              # Rust desktop shell
│   │       └── src/
│   │           ├── audio/          # Audio-Engine, STT, TTS, Übersetzungsrouting, Echtzeit-Provider
│   │           ├── bridge/         # Bridge-/Treiberinstallation und IPC-Verträge
│   │           ├── diagnostics/    # Logs, Traces, Diagnosestatus
│   │           ├── provider/       # AI Gateway, Provider-Vorlagen, HTTP/WS-Transport
│   │           ├── runtime/        # Fenster, Tray, Runtime-Status
│   │           └── storage/        # SQLite-Repository und Zugangsdatenverwaltung
│   └── bridge-service-native/      # Rust Native Bridge Service, einzige produktive Bridge-Implementierung
├── crates/                         # Gemeinsame Bibliotheken des Root-Cargo-Workspace
│   ├── omni-bridge-protocol/       # Von Desktop und Native Bridge gemeinsam genutztes Pipe-Protokoll
│   └── omni-logging/               # Gemeinsame nicht blockierende Logging-Pipeline
├── drivers/
│   └── windows-virtual-mic/        # Virtueller SYSVAD WaveRT-Audiotreiber
│       ├── include/                # Gemeinsame Driver/Bridge-IOCTL-ABI
│       ├── package/                # Metadaten des Treiberpakets
│       └── sysvad/                 # Aus dem Microsoft-SYSVAD-Beispiel angepasster Treiberquellcode
├── scripts/
│   ├── development/                # Entwicklungs-Startskripte
│   ├── diagnostics/                # Diagnosewerkzeuge
│   ├── installer/                  # Treiber-Build, Installation, Deinstallation, Reparatur, Probe
│   ├── release/                    # Release-Prüfung, Manifest, Paketierung, Signaturmanifest
│   └── testing/                    # Tests, Coverage, Quality Gates, Watch-Mode-Links
├── docs/                           # Architektur-, Qualitäts- und Projektdokumente, Provider/API-Referenzen
└── artifacts/                      # Build-Ausgaben, Logs, Diagnoseausgaben
```

## Kernabläufe

### Eingehende Übersetzung (Watch-/Untertitel-Szenarien)

```text
Systemaudio
  → Virtueller Audiotreiber / WASAPI-Erfassung
  → Native Bridge Service
  → Desktop Rust Audio Layer
  → VAD / Segmentierung
  → ASR
  → Translation Provider
  → Untertitel-Rendering (Hauptfenster + Overlay)
  → Optionales TTS
  → Lokale Lautsprecher- / Monitor-Ausgabe
```

### Ausgehende Übersetzung (Sprachraum-/Meeting-/Spiel-Szenarien)

```text
Mikrofon
  → Desktop Rust Audio Layer
  → VAD / Segmentierung
  → ASR
  → Translation Provider
  → TTS
  → Native Bridge Service
  → Virtueller Audiotreiber
  → Ziel-App liest das virtuelle Mikrofon / den virtuellen Endpunkt
```

### Latenz und degradierte Modi

- Untertitel und synchronisierte Sprachausgabe sind getrennte Planungsergebnisse; Untertitel werden zuerst übernommen.
- Wenn die Provider-Latenz das Budget überschreitet, wird `latency-high` ausgegeben, Untertitel laufen weiter und TTS wechselt in den deferred/queued-Status.
- Wenn Provider-Probing einen Provider als ungeeignet für Echtzeit markiert, wird synchronisierte Sprachausgabe standardmäßig deaktiviert und der untertitelorientierte Pfad bleibt aktiv.
- Fehler im Treiber oder in der Bridge blockieren den App-Start nicht; Untertitel, lokale Wiedergabe und Diagnoseseite sollen im degradierten Modus verfügbar bleiben.

## Technologie-Stack

| Ebene | Technologie |
| --- | --- |
| Frontend | React 19.2.x, TypeScript 6.0.x, Vite 8.x, Rolldown, CSS |
| Desktop-Shell | Tauri 2.x, `@tauri-apps/api`, `@tauri-apps/cli` |
| State und Routing | Zustand 5.x, react-router-dom 7.x |
| Internationalisierung | i18next 26.x, react-i18next 17.x, i18next-browser-languagedetector |
| Frontend-Tests | Vitest 4.x, jsdom 29.x, ESLint 10.x |
| Rust-Runtime | Rust 2021, Serde, Tauri commands/events |
| Provider-Netzwerk | reqwest 0.13, tungstenite 0.29, rustls |
| Speicher und Zugangsdaten | rusqlite 0.40 bundled SQLite, Windows Credential Manager |
| Audio | cpal 0.17, rodio 0.22, wasapi 0.23, hound |
| System-APIs | windows-sys 0.61 |
| Native Bridge | Rust sidecar, WASAPI, Named Pipe, IOCTL ABI |
| Treiber | Windows SYSVAD WaveRT virtueller Audiotreiber |
| Skripte | PowerShell, Node.js-Skripte für Release und Tests |

## Verträge und Datengrenzen

Das Projekt pflegt derzeit vier eingefrorene Vertragsbereiche:

1. **Provider Contract**: Provider-Metadaten, Auth-Referenzen, Anfrageparameter, Streaming-Ereignisse, Fehlerstrukturen und Probe-Ergebnisse.
2. **Audio Contract**: Systemaudio, Mikrofon, PCM-Frames, Segmente, Mischung, Latenzkompensation und Push-to-talk-Status.
3. **Driver Bridge Contract**: Initialisierung, Audioframes, Statusabfragen, Fehlerereignisse und Shutdown-Protokoll zwischen Desktop, Native Bridge und Treiber.
4. **OBS Integration Contract**: Reservierte Verbindungs- und Ausgabegrenze für künftige OBS-Untertitel-Overlays und Szenentrigger-Unterstützung.

Strukturierte Konfiguration verwendet SQLite als zentrale Quelle der Wahrheit. Sensible Zugangsdaten werden im Windows Credential Manager gespeichert. Logs, Caches, Glossarpakete und temporäre Audiodateien werden in getrennten Verzeichnissen abgelegt.

## Qualität und Tests

- `npm run verify:desktop`: Lint, Typecheck, Test und Build für das Desktop-Frontend.
- `npm run test:desktop-shell`: Tests für das Tauri-Rust-Backend.
- `npm run test:bridge-service-native`: Rust-Tests für die Native Bridge.
- `npm run test:contracts`: Prüfung eingefrorener Verträge auf TypeScript-/Rust-/Skript-Seite.
- `npm run quality:gate:auto`: automatisiertes Quality Gate.
- `npm run quality:gate:release`: Release-Quality-Gate mit Einstiegspunkten für manuelle Prüfung.
- `npm run test:watch-mode-report` / `npm run test:watch-mode-live:*`: Watch-Mode-Berichte, Nachweise und Live-Link-Testeinstiege.

## Entwicklung

### Frontend-Entwicklung

Das Frontend kann direkt mit `npm run dev:desktop` im Browser entwickelt werden. In Nicht-Tauri-Umgebungen gibt die Runtime-Schicht Mock-Daten zurück, sodass Seiten und Interaktionen geprüft werden können, ohne einen Treiber zu installieren oder das Rust-Backend zu starten.

### Desktop-Shell-Entwicklung und -Tests

Bei Arbeiten an `invoke`, Events, SQLite, dem Windows Credential Manager, der Native Bridge, System-Audio oder dem Untertitel-Overlay muss in der Tauri-Desktop-Shell getestet werden; die Browser-Mock-Vorschau kann dies nicht ersetzen.

```powershell
# Beim ersten Start oder nach Änderungen an Rust Core, Native Bridge oder der Cargo-Konfiguration
npm run dev:desktop-shell

# Tägliche Frontend-/Desktop-Abstimmung nach einem bereits erfolgreichen Standard-Build
npm run dev:desktop:fast
```

`dev:desktop:fast` überspringt den Release-Rebuild der Native Bridge und die UAC-Rechteerhöhung, die `dev:desktop-shell` durchführt: Es startet zuerst den Vite-Dienst auf Port `4173` vorab und wechselt dann in `tauri dev`, wobei der Cargo-Inkrementell-Cache wiederverwendet wird. Die Debug-EXE kann nicht direkt ausgeführt werden, da die Tauri-CLI weiterhin den für die WebView-IPC benötigten Laufzeitkontext bereitstellt. Beim ersten Start, nach Änderungen am Native-Bridge-Quellcode oder wenn der Rechteerhöhungsablauf geprüft werden muss, sollte weiterhin `dev:desktop-shell` verwendet werden.

Nach dem Start der Desktop-Shell sollten auf der Diagnoseseite mindestens folgende Signale bestätigt werden:

- `isTauri`, `IPC Bridge`, `window.ipc` und `isTauriRuntime` sind alle `true`.
- Der Bridge-Status ist `tauri-shell`, der normalisierte Umgebungsstatus ist nicht `runtime-error`.
- Der Speicherstatus ist `ready`, die Schema-Version ist mindestens `1`, das Credential-Backend ist nicht `browser-preview`.
- In `artifacts/diagnostics/logs/app.log` erscheint `debug_ipc_ping`, und nach dem Start tritt kein `startup.ipc_watchdog_reload` auf.

Beenden Sie den Desktop-Entwicklungsprozess, bevor Sie Rust-Prüfungen ausführen, damit ein laufender `tauri dev`-Prozess die Cargo-Build-Sperre nicht über längere Zeit blockiert:

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

### Treiberentwicklung

Zum Erstellen des Treibers sind Visual Studio 2022 + WDK erforderlich. Die Installation des Entwicklungstreibers erfordert Administratorrechte und den TESTSIGNING-Modus.

```bash
npm run driver:build-sysvad
npm run driver:install
npm run driver:test
npm run driver:uninstall
```

## Lizenz

Dieses Projekt ist unter der [Apache License 2.0](../LICENSE) lizenziert.
