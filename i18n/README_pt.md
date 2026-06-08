# Omni Translate

<h4 align="center">
    <p>
        <a href="../README.md">简体中文</a> |
        <a href="README_en.md">English</a> |
        <a href="README_es.md">Español</a> |
        <a href="README_ar.md">العربية</a> |
        <b>Português</b> |
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
        <a href="README_tr.md">Türkçe</a>
    </p>
</h4>

Omni Translate é um aplicativo desktop para Windows voltado à tradução de áudio em tempo real. Ele cobre fluxos de trabalho como tradução de legendas de vídeo, tradução de voz em jogos e tradução bidirecional para salas de voz ou reuniões. O aplicativo conecta um driver de áudio virtual, o Native Bridge, o runtime Rust Core e um AI Gateway unificado para processar captura de áudio, ASR, tradução por LLM, TTS, renderização de legendas e roteamento de reprodução.

## Destaques

- **Tradução de legendas em tempo real**: captura áudio do sistema ou do microfone, reconhece fala e exibe legendas traduzidas na janela principal e no overlay.
- **Overlay flutuante de legendas**: janela transparente, sem bordas e sempre no topo, projetada para ficar sobre vídeos, jogos ou aplicativos de reunião.
- **Tradução de voz bidirecional**: oferece suporte aos modos de roteamento assistir, jogo e sala de voz para legendas/voz de entrada e saída de microfone virtual.
- **Driver de áudio virtual**: driver de áudio virtual do Windows baseado em SYSVAD WaveRT, conectado ao modo de usuário por IOCTL e uma ABI compartilhada.
- **Rust Native Bridge**: `apps/bridge-service-native` é a única implementação de bridge de produção, responsável por WASAPI, Named Pipe IPC, frames de áudio e comunicação com o driver.
- **AI Gateway unificado**: integração baseada em templates para DashScope e providers compatíveis com OpenAI, com transportes HTTP, streaming HTTP e WebSocket.
- **Gerenciamento de glossários**: importa, exporta, mescla e prioriza pacotes de glossário de domínio, depois os injeta no fluxo de prompts de tradução.
- **Armazenamento seguro de credenciais**: chaves de API e outros segredos são armazenados no Windows Credential Manager, não em configuração de negócio em texto claro.
- **Diagnóstico e quality gates**: sondas de integridade do driver, traces de modelo, exportação de logs, testes Watch Mode em link real e quality gates de release.
- **20 idiomas de interface**: os recursos de locale atuais cobrem `ar`, `bn`, `de`, `en`, `es`, `fil`, `fr`, `hi`, `id`, `ja`, `ko`, `mr`, `pt`, `ru`, `ta`, `te`, `th`, `tr`, `vi` e `zh-CN`.

## Início rápido

### Requisitos

- **Node.js** >= 20
- **Rust stable**, edição 2021
- **Windows 10/11**
- **Visual Studio 2022 + WDK 10.0.26100**, necessário apenas para compilar o driver de áudio virtual
- O carregamento de drivers de desenvolvimento exige o modo Windows TESTSIGNING; a prévia frontend normal não exige driver nem privilégios de administrador

### Instalação e execução

```bash
# 1. Clonar o repositório
git clone <repo-url>
cd omni-translate

# 2. Instalar dependências
npm install

# 3. Iniciar a prévia frontend no navegador
npm run dev:desktop

# 4. Iniciar o aplicativo desktop Tauri completo
npm run dev:desktop-shell
```

O modo de prévia no navegador usa automaticamente o mock runtime, sendo adequado para desenvolvimento de UI e verificação de páginas. O aplicativo desktop completo inicia o runtime Tauri/Rust e só aciona elevação quando há ações de instalação ou reparo do driver.

### Comandos comuns

| Comando | Descrição |
| --- | --- |
| `npm run dev:desktop` | Inicia o servidor de desenvolvimento frontend React/Vite |
| `npm run dev:desktop-shell` | Inicia o aplicativo desktop Tauri completo pelo script de elevação |
| `npm run lint:desktop` | Executa ESLint para o frontend desktop |
| `npm run check:desktop` | Executa a verificação de tipos TypeScript |
| `npm run build:desktop` | Compila os artefatos frontend |
| `npm run check:desktop-shell` | Verifica o backend Rust do Tauri |
| `npm run build:desktop-shell` | Compila o aplicativo Tauri completo |
| `npm run build:bridge-service-native` | Compila o Rust Native Bridge Service |
| `npm run test:all` | Executa o ponto de entrada de todos os testes |
| `npm run test:contracts` | Verifica contratos congelados |
| `npm run test:watch-mode-live:dry-run` | Executa o dry-run de link real do Watch Mode |
| `npm run quality:gate:auto` | Executa o quality gate automatizado |
| `npm run quality:gate:release` | Executa o quality gate de release |
| `npm run driver:build-sysvad` | Compila o driver de áudio virtual SYSVAD |
| `npm run driver:install` | Instala o driver de desenvolvimento |
| `npm run driver:test` | Sonda o status do driver de desenvolvimento |
| `npm run driver:uninstall` | Desinstala o driver de desenvolvimento |
| `npm run release:prepare` | Executa o pipeline de preparação de release |

## Arquitetura do sistema

```text
┌────────────────────────────────────────────────────────────┐
│ 1. Desktop Shell                                            │
│    Tauri 2 + React 19 + TypeScript 6 + Vite 8/Rolldown      │
│    Janela principal, overlay de legendas, roteamento,       │
│    configurações, diagnóstico, páginas de provider          │
├────────────────────────────────────────────────────────────┤
│ 2. Rust Core Runtime                                        │
│    Tauri commands/events, orquestração de sessão, armazenamento,│
│    diagnóstico, integração com tray                         │
├────────────────────────────────────────────────────────────┤
│ 3. Audio Layer                                              │
│    WASAPI + cpal + rodio, captura sistema/microfone, VAD,   │
│    segmentação, mixagem                                     │
├────────────────────────────────────────────────────────────┤
│ 4. AI Gateway                                               │
│    reqwest + tungstenite, providers ASR / Translation / TTS  │
│    Templates DashScope e compatíveis OpenAI, sondas, erros  │
├────────────────────────────────────────────────────────────┤
│ 5. Native Bridge Service                                    │
│    Rust sidecar, WASAPI, Named Pipe IPC, frames de áudio,   │
│    IOCTL do driver                                          │
├────────────────────────────────────────────────────────────┤
│ 6. Driver / Installer                                       │
│    Driver de áudio virtual SYSVAD WaveRT, instalação,       │
│    rollback, reparo, sondagem de integridade                │
└────────────────────────────────────────────────────────────┘
```

## Estrutura de diretórios

```text
omni-translate/
├── apps/
│   ├── desktop/                    # Aplicativo desktop Tauri
│   │   ├── src/                    # Frontend React
│   │   │   ├── components/         # Componentes UI compartilhados
│   │   │   ├── i18n/               # Recursos de locale UI para 20 idiomas
│   │   │   ├── pages/              # Páginas de sessão, roteamento, provider, glossário, configurações e diagnóstico
│   │   │   ├── runtime/            # Adaptadores frontend runtime/IPC
│   │   │   ├── schema/             # Contratos e tipos TypeScript
│   │   │   └── stores/             # Estado Zustand
│   │   └── src-tauri/              # Rust desktop shell
│   │       └── src/
│   │           ├── audio/          # Motor de áudio, STT, TTS, roteamento de tradução, providers em tempo real
│   │           ├── bridge/         # Instalação de Bridge/driver e contratos IPC
│   │           ├── diagnostics/    # Logs, traces, estado de diagnóstico
│   │           ├── provider/       # AI Gateway, templates de provider, transporte HTTP/WS
│   │           ├── runtime/        # Janelas, tray, estado runtime
│   │           └── storage/        # Repositório SQLite e gestão de credenciais
│   └── bridge-service-native/      # Rust Native Bridge Service, única implementação de bridge de produção
├── drivers/
│   └── windows-virtual-mic/        # Driver de áudio virtual SYSVAD WaveRT
│       ├── include/                # ABI IOCTL compartilhada Driver/Bridge
│       ├── package/                # Metadados do pacote do driver
│       └── sysvad/                 # Fonte do driver modificada a partir do exemplo SYSVAD da Microsoft
├── scripts/
│   ├── development/                # Scripts de inicialização de desenvolvimento
│   ├── diagnostics/                # Ferramentas de diagnóstico
│   ├── installer/                  # Build, instalação, desinstalação, reparo e sondagem do driver
│   ├── release/                    # Verificação de release, manifest, empacotamento, manifest de assinatura
│   └── testing/                    # Testes, cobertura, quality gates, links Watch Mode
├── docs/                           # Documentação de arquitetura, qualidade e projeto, referências provider/API
└── artifacts/                      # Saídas de build, logs e saídas de diagnóstico
```

## Fluxos principais

### Tradução de entrada (cenários de visualização/legendas)

```text
Áudio do sistema
  → Driver de áudio virtual / captura WASAPI
  → Native Bridge Service
  → Desktop Rust Audio Layer
  → VAD / segmentação
  → ASR
  → Translation Provider
  → Renderização de legendas (janela principal + overlay)
  → TTS opcional
  → Alto-falante local / saída de monitoramento
```

### Tradução de saída (cenários de sala de voz/reunião/jogo)

```text
Microfone
  → Desktop Rust Audio Layer
  → VAD / segmentação
  → ASR
  → Translation Provider
  → TTS
  → Native Bridge Service
  → Driver de áudio virtual
  → O aplicativo de destino lê o microfone virtual / endpoint virtual
```

### Latência e modos degradados

- Legendas e voz dublada são resultados de agendamento separados; as legendas são confirmadas primeiro.
- Quando a latência do provider excede o orçamento, `latency-high` é emitido, as legendas continuam e TTS passa para o estado deferred/queued.
- Quando a sondagem de provider marca um provider como inadequado para tempo real, a voz dublada é desativada por padrão e o caminho com prioridade para legendas permanece ativo.
- Falhas no driver ou na Bridge não bloqueiam a inicialização do aplicativo; legendas, reprodução local e diagnóstico devem permanecer disponíveis em modo degradado.

## Stack tecnológica

| Camada | Tecnologia |
| --- | --- |
| Frontend | React 19.2.x, TypeScript 6.0.x, Vite 8.x, Rolldown, CSS |
| Shell desktop | Tauri 2.x, `@tauri-apps/api`, `@tauri-apps/cli` |
| Estado e roteamento | Zustand 5.x, react-router-dom 7.x |
| Internacionalização | i18next 26.x, react-i18next 17.x, i18next-browser-languagedetector |
| Testes frontend | Vitest 4.x, jsdom 29.x, ESLint 10.x |
| Runtime Rust | Rust 2021, Serde, Tauri commands/events |
| Rede de provider | reqwest 0.13, tungstenite 0.29, rustls |
| Armazenamento e credenciais | rusqlite 0.40 bundled SQLite, keyring 4, Windows Credential Manager |
| Áudio | cpal 0.17, rodio 0.22, wasapi 0.23, hound, minimp3 |
| APIs do sistema | windows-sys 0.61 |
| Native Bridge | Rust sidecar, WASAPI, Named Pipe, IOCTL ABI |
| Driver | Driver de áudio virtual Windows SYSVAD WaveRT |
| Scripts | PowerShell, scripts Node.js de release e testes |

## Contratos e limites de dados

O projeto mantém atualmente quatro áreas de contratos congelados:

1. **Provider Contract**: metadados de provider, referências de autenticação, parâmetros de requisição, eventos de streaming, estruturas de erro e resultados de sondagem.
2. **Audio Contract**: áudio do sistema, microfone, frames PCM, segmentos, mixagem, compensação de latência e estado push-to-talk.
3. **Driver Bridge Contract**: inicialização, frames de áudio, consultas de estado, eventos de erro e protocolo de desligamento entre Desktop, Native Bridge e driver.
4. **OBS Integration Contract**: limite de conexão e saída reservado para futuro suporte a overlay de legendas OBS e gatilhos de cena.

A configuração estruturada usa SQLite como principal fonte de verdade. Credenciais sensíveis são armazenadas no Windows Credential Manager. Logs, caches, pacotes de glossário e arquivos temporários de áudio ficam em diretórios separados.

## Qualidade e testes

- `npm run verify:desktop`: lint, typecheck, test e build do frontend desktop.
- `npm run test:desktop-shell`: testes do backend Rust do Tauri.
- `npm run test:bridge-service-native`: testes Rust do Native Bridge.
- `npm run test:contracts`: verificação de contratos congelados em TypeScript/Rust/scripts.
- `npm run quality:gate:auto`: quality gate automatizado.
- `npm run quality:gate:release`: quality gate de release com pontos de entrada de verificação manual.
- `npm run test:watch-mode-report` / `npm run test:watch-mode-live:*`: relatórios Watch Mode, evidências e pontos de entrada de testes em link real.

## Desenvolvimento

### Desenvolvimento frontend

Use `npm run dev:desktop` para desenvolver o frontend em um navegador. Em ambientes que não são Tauri, a camada runtime retorna dados mock para que páginas e interações possam ser verificadas sem instalar o driver nem iniciar o backend Rust.

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

### Desenvolvimento do driver

Compilar o driver exige Visual Studio 2022 + WDK. Instalar o driver de desenvolvimento exige privilégios de administrador e o modo TESTSIGNING.

```bash
npm run driver:build-sysvad
npm run driver:install
npm run driver:test
npm run driver:uninstall
```

## Licença

Este projeto usa licença privada. Todos os direitos reservados.
