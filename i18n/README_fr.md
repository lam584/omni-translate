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
        <b>Français</b> |
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

Omni Translate est une application de bureau Windows pour la traduction audio en temps réel. Elle couvre des workflows tels que la traduction de sous-titres vidéo, la traduction vocale dans les jeux et la traduction bidirectionnelle pour les salons vocaux ou les réunions. L’application relie un pilote audio virtuel, le Native Bridge, le runtime Rust Core et un AI Gateway unifié afin de traiter la capture audio, l’ASR, la traduction LLM, le TTS, le rendu des sous-titres et le routage de lecture.

## Fonctionnalités

- **Traduction de sous-titres en temps réel** : capture l’audio système ou micro, reconnaît la parole et affiche les sous-titres traduits dans la fenêtre principale et l’overlay.
- **Overlay flottant de sous-titres** : fenêtre transparente, sans bordure et toujours au premier plan, conçue pour se superposer aux vidéos, jeux ou applications de réunion.
- **Traduction vocale bidirectionnelle** : prend en charge les modes de routage visionnage, jeu et salon vocal pour les sous-titres/voix entrants et la sortie micro virtuelle sortante.
- **Pilote audio virtuel** : pilote audio virtuel Windows basé sur SYSVAD WaveRT, connecté au mode utilisateur via IOCTL et une ABI partagée.
- **Rust Native Bridge** : `apps/bridge-service-native` est la seule implémentation de bridge de production, responsable de WASAPI, Named Pipe IPC, des trames audio et de la communication avec le pilote.
- **AI Gateway unifié** : intégration pilotée par modèles pour DashScope et les fournisseurs compatibles OpenAI, avec transports HTTP, streaming HTTP et WebSocket.
- **Gestion des glossaires** : importe, exporte, fusionne et priorise les packages de glossaires métier, puis les injecte dans le flux de prompts de traduction.
- **Stockage sécurisé des identifiants** : les clés API et autres secrets sont stockés dans Windows Credential Manager plutôt que dans une configuration métier en clair.
- **Diagnostics et quality gates** : sondes de santé du pilote, traces de modèle, export de logs, tests Watch Mode en lien réel et quality gates de publication.
- **20 langues d’interface** : les ressources de locale actuelles couvrent `ar`, `bn`, `de`, `en`, `es`, `fil`, `fr`, `hi`, `id`, `ja`, `ko`, `mr`, `pt`, `ru`, `ta`, `te`, `th`, `tr`, `vi` et `zh-CN`.

## Démarrage rapide

### Prérequis

- **Node.js** >= 20
- **Rust stable**, édition 2021
- **Windows 10/11**
- **Visual Studio 2022 Build Tools + Desktop development with C++**, requis pour compiler le Tauri desktop shell et le Native Bridge ; `cl.exe` et `link.exe` doivent être accessibles en ligne de commande
- **WDK 10.0.26100**, requis uniquement pour compiler le pilote audio virtuel
- Le chargement des pilotes de développement nécessite le mode Windows TESTSIGNING ; l’aperçu frontend standard ne nécessite ni pilote ni droits administrateur

### Installation et exécution

```bash
# 1. Cloner le dépôt
git clone <repo-url>
cd omni-translate

# 2. Installer les dépendances selon package-lock.json
npm ci

# 3. Démarrer l’aperçu frontend dans le navigateur
npm run dev:desktop

# 4. Démarrer l’application desktop Tauri complète
npm run dev:desktop-shell
```

Le mode d’aperçu navigateur utilise automatiquement le mock runtime, ce qui le rend adapté au développement UI et aux vérifications de pages. L’application desktop complète démarre le runtime Tauri/Rust et ne déclenche l’élévation que lorsque des actions d’installation ou de réparation du pilote sont impliquées.

Avant de lancer pour la première fois le shell desktop complet, il est recommandé d’ouvrir le dépôt depuis **Developer PowerShell** ou **x64 Native Tools Command Prompt** de Visual Studio 2022. Si un PowerShell classique indique `link.exe not found`, chargez d’abord l’environnement MSVC :

```powershell
& "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\Launch-VsDevShell.ps1" -Arch amd64 -HostArch amd64
npm run dev:desktop-shell
```

`dev:desktop-shell` compile d’abord une version release du Native Bridge, puis démarre Vite, le Rust Core et la fenêtre desktop via Tauri dev ; le script demande une élévation UAC. La première compilation Rust doit télécharger et compiler les dépendances, ce qui la rend nettement plus longue que les démarrages suivants.

### Commandes courantes

| Commande | Description |
| --- | --- |
| `npm run dev:desktop` | Démarre le serveur de développement frontend React/Vite |
| `npm run dev:desktop-shell` | Démarre l’application desktop Tauri complète via le script d’élévation |
| `npm run dev:desktop:fast` | Ignore la reconstruction release du Native Bridge et l’élévation, en réutilisant le cache incrémental de Cargo pour le travail quotidien sur le desktop |
| `npm run lint:desktop` | Exécute ESLint pour le frontend desktop |
| `npm run check:desktop` | Exécute la vérification de types TypeScript |
| `npm run build:desktop` | Compile les ressources frontend |
| `npm run check:desktop-shell` | Vérifie le backend Rust Tauri |
| `npm run build:desktop-shell` | Compile l’application Tauri complète |
| `npm run build:bridge-service-native` | Compile le Rust Native Bridge Service |
| `npm run test:all` | Exécute le point d’entrée de tous les tests |
| `npm run test:contracts` | Vérifie les contrats figés |
| `npm run test:watch-mode-live:dry-run` | Exécute le dry-run de lien réel Watch Mode |
| `npm run quality:gate:auto` | Exécute le quality gate automatisé |
| `npm run quality:gate:release` | Exécute le quality gate de publication |
| `npm run driver:build-sysvad` | Compile le pilote audio virtuel SYSVAD |
| `npm run driver:install` | Installe le pilote de développement |
| `npm run driver:test` | Sonde l’état du pilote de développement |
| `npm run driver:uninstall` | Désinstalle le pilote de développement |
| `npm run release:prepare` | Exécute le pipeline de préparation de publication |

## Architecture système

```text
┌────────────────────────────────────────────────────────────┐
│ 1. Desktop Shell                                            │
│    Tauri 2 + React 19 + TypeScript 6 + Vite 8/Rolldown      │
│    Fenêtre principale, overlay de sous-titres, routage,     │
│    paramètres, diagnostics, pages provider                  │
├────────────────────────────────────────────────────────────┤
│ 2. Rust Core Runtime                                        │
│    Tauri commands/events, orchestration de session, stockage,│
│    diagnostics, intégration au tray                         │
├────────────────────────────────────────────────────────────┤
│ 3. Audio Layer                                              │
│    WASAPI + cpal + rodio, capture système/micro, VAD,       │
│    segmentation, mixage                                     │
├────────────────────────────────────────────────────────────┤
│ 4. AI Gateway                                               │
│    reqwest + tungstenite, providers ASR / Translation / TTS  │
│    Modèles DashScope et compatibles OpenAI, sondes, erreurs │
├────────────────────────────────────────────────────────────┤
│ 5. Native Bridge Service                                    │
│    Rust sidecar, WASAPI, Named Pipe IPC, trames audio,      │
│    IOCTL du pilote                                          │
├────────────────────────────────────────────────────────────┤
│ 6. Driver / Installer                                       │
│    Pilote audio virtuel SYSVAD WaveRT, installation,        │
│    rollback, réparation, sondes de santé                    │
└────────────────────────────────────────────────────────────┘
```

## Structure des répertoires

```text
omni-translate/
├── apps/
│   ├── desktop/                    # Application desktop Tauri
│   │   ├── src/                    # Frontend React
│   │   │   ├── components/         # Composants UI partagés
│   │   │   ├── i18n/               # Ressources de locale UI pour 20 langues
│   │   │   ├── pages/              # Pages session, routage, provider, glossaire, paramètres, diagnostics
│   │   │   ├── runtime/            # Adaptateurs frontend runtime/IPC
│   │   │   ├── schema/             # Contrats et types TypeScript
│   │   │   └── stores/             # État Zustand
│   │   └── src-tauri/              # Rust desktop shell
│   │       └── src/
│   │           ├── audio/          # Moteur audio, STT, TTS, routage de traduction, providers temps réel
│   │           ├── bridge/         # Installation Bridge/pilote et contrats IPC
│   │           ├── diagnostics/    # Logs, traces, état de diagnostic
│   │           ├── provider/       # AI Gateway, modèles provider, transport HTTP/WS
│   │           ├── runtime/        # Fenêtres, tray, état runtime
│   │           └── storage/        # Dépôt SQLite et gestion des identifiants
│   └── bridge-service-native/      # Rust Native Bridge Service, seule implémentation bridge de production
├── crates/                         # Bibliothèques partagées du workspace Cargo racine
│   ├── omni-bridge-protocol/       # Protocole de pipe partagé entre Desktop et Native Bridge
│   └── omni-logging/               # Pipeline de logging non bloquant partagé
├── drivers/
│   └── windows-virtual-mic/        # Pilote audio virtuel SYSVAD WaveRT
│       ├── include/                # ABI IOCTL partagée Driver/Bridge
│       ├── package/                # Métadonnées du package de pilote
│       └── sysvad/                 # Source du pilote modifiée depuis l’exemple Microsoft SYSVAD
├── scripts/
│   ├── development/                # Scripts de lancement de développement
│   ├── diagnostics/                # Outils de diagnostic
│   ├── installer/                  # Build, installation, désinstallation, réparation, sonde du pilote
│   ├── release/                    # Vérification de release, manifest, packaging, manifest de signature
│   └── testing/                    # Tests, couverture, quality gates, liens Watch Mode
├── docs/                           # Architecture, qualité, documentation projet et références provider/API
└── artifacts/                      # Sorties de build, logs et sorties de diagnostic
```

## Flux principaux

### Traduction entrante (scénarios visionnage/sous-titres)

```text
Audio système
  → Pilote audio virtuel / capture WASAPI
  → Native Bridge Service
  → Desktop Rust Audio Layer
  → VAD / segmentation
  → ASR
  → Translation Provider
  → Rendu des sous-titres (fenêtre principale + overlay)
  → TTS facultatif
  → Haut-parleur local / sortie de monitoring
```

### Traduction sortante (scénarios salon vocal/réunion/jeu)

```text
Microphone
  → Desktop Rust Audio Layer
  → VAD / segmentation
  → ASR
  → Translation Provider
  → TTS
  → Native Bridge Service
  → Pilote audio virtuel
  → L’application cible lit le micro virtuel / endpoint virtuel
```

### Latence et modes dégradés

- Les sous-titres et la voix doublée sont des résultats planifiés séparément ; les sous-titres sont validés en premier.
- Lorsque la latence du provider dépasse le budget, `latency-high` est émis, les sous-titres continuent et le TTS passe à l’état deferred/queued.
- Lorsqu’une sonde de provider indique qu’il n’est pas adapté au temps réel, la voix doublée est désactivée par défaut et le chemin priorisant les sous-titres reste actif.
- Les échecs du pilote ou du Bridge ne bloquent pas le démarrage de l’application ; les sous-titres, la lecture locale et les diagnostics doivent rester disponibles en mode dégradé.

## Stack technique

| Couche | Technologie |
| --- | --- |
| Frontend | React 19.2.x, TypeScript 6.0.x, Vite 8.x, Rolldown, CSS |
| Shell desktop | Tauri 2.x, `@tauri-apps/api`, `@tauri-apps/cli` |
| État et routage | Zustand 5.x, react-router-dom 7.x |
| Internationalisation | i18next 26.x, react-i18next 17.x, i18next-browser-languagedetector |
| Tests frontend | Vitest 4.x, jsdom 29.x, ESLint 10.x |
| Runtime Rust | Rust 2021, Serde, Tauri commands/events |
| Réseau provider | reqwest 0.13, tungstenite 0.29, rustls |
| Stockage et identifiants | rusqlite 0.40 bundled SQLite, Windows Credential Manager |
| Audio | cpal 0.17, rodio 0.22, wasapi 0.23, hound |
| APIs système | windows-sys 0.61 |
| Native Bridge | Rust sidecar, WASAPI, Named Pipe, IOCTL ABI |
| Pilote | Pilote audio virtuel Windows SYSVAD WaveRT |
| Scripts | PowerShell, scripts Node.js de publication et de test |

## Contrats et limites de données

Le projet maintient actuellement quatre zones de contrats figés :

1. **Provider Contract** : métadonnées provider, références d’authentification, paramètres de requête, événements de streaming, structures d’erreur et résultats de sonde.
2. **Audio Contract** : audio système, microphone, trames PCM, segments, mixage, compensation de latence et état push-to-talk.
3. **Driver Bridge Contract** : initialisation, trames audio, requêtes d’état, événements d’erreur et protocole d’arrêt entre Desktop, Native Bridge et le pilote.
4. **OBS Integration Contract** : limite de connexion et de sortie réservée pour une future prise en charge des overlays de sous-titres OBS et des déclencheurs de scène.

La configuration structurée utilise SQLite comme source principale de vérité. Les identifiants sensibles sont stockés dans Windows Credential Manager. Les logs, caches, packages de glossaires et fichiers audio temporaires sont conservés dans des répertoires séparés.

## Qualité et tests

- `npm run verify:desktop` : lint, typecheck, test et build du frontend desktop.
- `npm run test:desktop-shell` : tests du backend Rust Tauri.
- `npm run test:bridge-service-native` : tests Rust du Native Bridge.
- `npm run test:contracts` : vérification des contrats figés côté TypeScript/Rust/scripts.
- `npm run quality:gate:auto` : quality gate automatisé.
- `npm run quality:gate:release` : quality gate de publication avec points d’entrée de vérification manuelle.
- `npm run test:watch-mode-report` / `npm run test:watch-mode-live:*` : rapports Watch Mode, preuves et points d’entrée de tests en lien réel.

## Développement

### Développement frontend

Utilisez `npm run dev:desktop` pour développer le frontend dans un navigateur. Dans les environnements non Tauri, la couche runtime renvoie des données mock afin de vérifier les pages et interactions sans installer le pilote ni démarrer le backend Rust.

### Développement et tests du shell desktop

Tout ce qui touche à `invoke`, aux events, à SQLite, à Windows Credential Manager, au Native Bridge, à l’audio système ou à l’overlay de sous-titres doit être testé dans le shell desktop Tauri ; un aperçu mock dans le navigateur ne peut pas s’y substituer.

```powershell
# Premier lancement, ou après modification du Rust Core, du Native Bridge ou de la configuration Cargo
npm run dev:desktop-shell

# Itération quotidienne frontend/desktop une fois qu’une compilation standard a déjà réussi
npm run dev:desktop:fast
```

`dev:desktop:fast` ignore la reconstruction release du Native Bridge et l’élévation UAC effectuées par `dev:desktop-shell` : il démarre et préchauffe d’abord le serveur Vite sur le port `4173`, puis entre dans `tauri dev` en réutilisant le cache incrémental de Cargo. Vous ne pouvez pas exécuter directement l’EXE de debug, car la CLI Tauri est aussi responsable de fournir le contexte runtime IPC du WebView. Continuez à utiliser `dev:desktop-shell` lors du premier lancement, après des modifications du code source du Native Bridge, ou lorsque vous devez vérifier le flux d’élévation.

Une fois le shell desktop démarré, vérifiez au moins les signaux suivants sur la page Diagnostics :

- `isTauri`, `IPC Bridge`, `window.ipc` et `isTauriRuntime` sont tous à `true`.
- Le statut du bridge est `tauri-shell` et l’état d’environnement normalisé n’est pas `runtime-error`.
- Le statut de stockage est `ready`, la version du schema est au moins `1`, et le backend d’identifiants n’est pas `browser-preview`.
- `artifacts/diagnostics/logs/app.log` affiche `debug_ipc_ping`, sans `startup.ipc_watchdog_reload` après le démarrage.

Arrêtez le processus de développement desktop avant d’exécuter les vérifications Rust, afin qu’un `tauri dev` en cours d’exécution ne retienne pas trop longtemps le verrou de build Cargo :

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

### Développement du pilote

La compilation du pilote nécessite Visual Studio 2022 + WDK. L’installation du pilote de développement nécessite des droits administrateur et le mode TESTSIGNING.

```bash
npm run driver:build-sysvad
npm run driver:install
npm run driver:test
npm run driver:uninstall
```

## Licence

Ce projet est distribué sous licence [Apache License 2.0](../LICENSE).
