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

Omni Translate ist eine Windows-Desktopanwendung für Audioübersetzung in Echtzeit. Sie deckt Workflows wie Videountertitel-Übersetzung, Sprachübersetzung in Spielen und bidirektionale Übersetzung für Sprachräume oder Meetings ab. Die App verbindet einen virtuellen Audiotreiber, die native Bridge, die Rust-Core-Runtime und ein einheitliches AI Gateway, um Audioerfassung, ASR, LLM-Übersetzung, TTS, Untertitel-Rendering und Wiedergaberouting zu verarbeiten.

## Funktionen

- **Untertitelübersetzung in Echtzeit**: Erfasst System- oder Mikrofon-Audio, erkennt Sprache und zeigt übersetzte Untertitel im Hauptfenster und im Overlay an.
- **Schwebendes Untertitel-Overlay**: Ein transparentes, rahmenloses Fenster, das immer im Vordergrund bleibt und über Videos, Spielen oder Meeting-Apps liegen kann.
- **Bidirektionale Sprachübersetzung**: Unterstützt Routing-Modi für Anschauen, Spiele und Sprachräume für eingehende Untertitel/Sprachausgabe und ausgehende virtuelle Mikrofon-Ausgabe.
- **Virtueller Audiotreiber**: Windows-virtueller Audiotreiber auf Basis von SYSVAD WaveRT, verbunden mit dem Benutzermodus über IOCTL und eine gemeinsame ABI.
- **Rust Native Bridge**: `apps/bridge-service-native` ist die einzige produktive Bridge-Implementierung und verarbeitet WASAPI, Named Pipe IPC, Audioframes und Treiberkommunikation.
- **Einheitliches AI Gateway**: Vorlagenbasierte Integration von DashScope und OpenAI-kompatiblen Providern mit HTTP, streaming HTTP und WebSocket-Transporten.
- **Glossarverwaltung**: Importiert, exportiert, kombiniert und priorisiert domänenspezifische Glossarpakete und speist sie in den Übersetzungs-Prompt-Fluss ein.
- **Sichere Speicherung von Zugangsdaten**: API-Schlüssel und andere Geheimnisse werden im Windows Credential Manager statt in Klartext-Konfigurationen gespeichert.
- **Diagnose und Quality Gates**: Treiber-Health-Probes, Modell-Traces, Logexport, Watch-Mode-Live-Link-Tests und Quality Gates für Releases.
- **20 UI-Sprachen**: Die aktuellen Locale-Ressourcen decken `ar`, `bn`, `de`, `en`, `es`, `fil`, `fr`, `hi`, `id`, `ja`, `ko`, `mr`, `pt`, `ru`, `ta`, `te`, `th`, `tr`, `vi` und `zh-CN` ab.

## Schnellstart

### Voraussetzungen

- **Node.js** >= 20
- **Rust stable**, Edition 2021
- **Windows 10/11**
- **Visual Studio 2022 + WDK 10.0.26100**, nur zum Erstellen des virtuellen Audiotreibers erforderlich
- Das Laden von Entwicklungstreibern erfordert den Windows-TESTSIGNING-Modus; die normale Frontend-Vorschau benötigt weder Treiber noch Administratorrechte

### Installation und Start

```bash
# 1. Repository klonen
git clone <repo-url>
cd omni-translate

# 2. Abhängigkeiten installieren
npm install

# 3. Frontend-Browser-Vorschau starten
npm run dev:desktop

# 4. Vollständige Tauri-Desktop-App starten
npm run dev:desktop-shell
```

Der Browser-Vorschaumodus verwendet automatisch die Mock-Runtime und eignet sich für UI-Entwicklung und Seitenprüfungen. Die vollständige Desktop-App startet die Tauri/Rust-Runtime und löst eine Rechteerhöhung nur bei Treiberinstallation, Reparatur oder ähnlichen Aktionen aus.

### Häufige Befehle

| Befehl | Beschreibung |
| --- | --- |
| `npm run dev:desktop` | Startet den React/Vite-Frontend-Entwicklungsserver |
| `npm run dev:desktop-shell` | Startet die vollständige Tauri-Desktop-App über das Skript zur Rechteerhöhung |
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
- Fehler im Treiber oder in der Bridge blockieren den App-Start nicht; Untertitel, lokale Wiedergabe und Diagnose sollen im degradierten Modus verfügbar bleiben.

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
| Speicher und Zugangsdaten | rusqlite 0.40 bundled SQLite, keyring 4, Windows Credential Manager |
| Audio | cpal 0.17, rodio 0.22, wasapi 0.23, hound, minimp3 |
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

Verwenden Sie `npm run dev:desktop`, um das Frontend im Browser zu entwickeln. In Nicht-Tauri-Umgebungen gibt die Runtime-Schicht Mock-Daten zurück, sodass Seiten und Interaktionen ohne Treiberinstallation oder gestartetes Rust-Backend geprüft werden können.

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

Dieses Projekt ist privat lizenziert. Alle Rechte vorbehalten.
