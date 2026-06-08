# Omni Translate

<h4 align="center">
    <p>
        <a href="../README.md">简体中文</a> |
        <a href="README_en.md">English</a> |
        <b>Español</b> |
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
        <a href="README_tr.md">Türkçe</a>
    </p>
</h4>

Omni Translate es una aplicación de escritorio para Windows dedicada a la traducción de audio en tiempo real. Cubre flujos de trabajo como la traducción de subtítulos de video, la traducción de voz en juegos y la traducción bidireccional para salas de voz o reuniones. La aplicación conecta un controlador de audio virtual, el Native Bridge, el runtime Rust Core y un AI Gateway unificado para procesar captura de audio, ASR, traducción con LLM, TTS, renderizado de subtítulos y enrutamiento de reproducción.

## Funciones destacadas

- **Traducción de subtítulos en tiempo real**: captura audio del sistema o del micrófono, reconoce el habla y muestra subtítulos traducidos en la ventana principal y en la superposición.
- **Superposición flotante de subtítulos**: ventana transparente, sin bordes y siempre visible, diseñada para colocarse sobre videos, juegos o aplicaciones de reuniones.
- **Traducción de voz bidireccional**: admite modos de enrutamiento para visualización, juego y sala de voz, con subtítulos/voz entrantes y salida de micrófono virtual saliente.
- **Controlador de audio virtual**: controlador de audio virtual de Windows basado en SYSVAD WaveRT, conectado al modo de usuario mediante IOCTL y una ABI compartida.
- **Rust Native Bridge**: `apps/bridge-service-native` es la única implementación de puente de producción y gestiona WASAPI, Named Pipe IPC, tramas de audio y comunicación con el controlador.
- **AI Gateway unificado**: integración basada en plantillas para DashScope y proveedores compatibles con OpenAI, con transportes HTTP, streaming HTTP y WebSocket.
- **Gestión de glosarios**: importa, exporta, combina y prioriza paquetes de glosarios de dominio, y los inyecta en el flujo de prompts de traducción.
- **Almacenamiento seguro de credenciales**: las claves API y otros secretos se guardan en Windows Credential Manager en lugar de configuraciones de negocio en texto plano.
- **Diagnóstico y puertas de calidad**: sondas de salud del controlador, trazas de modelo, exportación de logs, pruebas Watch Mode de enlace real y puertas de calidad para releases.
- **20 idiomas de interfaz**: los recursos de locale actuales cubren `ar`, `bn`, `de`, `en`, `es`, `fil`, `fr`, `hi`, `id`, `ja`, `ko`, `mr`, `pt`, `ru`, `ta`, `te`, `th`, `tr`, `vi` y `zh-CN`.

## Inicio rápido

### Requisitos

- **Node.js** >= 20
- **Rust stable**, edición 2021
- **Windows 10/11**
- **Visual Studio 2022 + WDK 10.0.26100**, necesario solo para compilar el controlador de audio virtual
- La carga de controladores de desarrollo requiere el modo Windows TESTSIGNING; la vista previa frontend normal no requiere controlador ni privilegios de administrador

### Instalación y ejecución

```bash
# 1. Clonar el repositorio
git clone <repo-url>
cd omni-translate

# 2. Instalar dependencias
npm install

# 3. Iniciar la vista previa frontend en el navegador
npm run dev:desktop

# 4. Iniciar la aplicación de escritorio Tauri completa
npm run dev:desktop-shell
```

El modo de vista previa en navegador usa automáticamente el mock runtime, por lo que resulta adecuado para desarrollo de UI y revisión de páginas. La aplicación de escritorio completa inicia el runtime Tauri/Rust y solo activa elevación cuando intervienen acciones de instalación o reparación del controlador.

### Comandos comunes

| Comando | Descripción |
| --- | --- |
| `npm run dev:desktop` | Inicia el servidor de desarrollo frontend React/Vite |
| `npm run dev:desktop-shell` | Inicia la aplicación de escritorio Tauri completa mediante el script de elevación |
| `npm run lint:desktop` | Ejecuta ESLint para el frontend de escritorio |
| `npm run check:desktop` | Ejecuta la comprobación de tipos de TypeScript |
| `npm run build:desktop` | Compila los recursos frontend |
| `npm run check:desktop-shell` | Comprueba el backend Rust de Tauri |
| `npm run build:desktop-shell` | Compila la aplicación Tauri completa |
| `npm run build:bridge-service-native` | Compila el Rust Native Bridge Service |
| `npm run test:all` | Ejecuta el punto de entrada de todas las pruebas |
| `npm run test:contracts` | Verifica los contratos congelados |
| `npm run test:watch-mode-live:dry-run` | Ejecuta el dry-run de enlace real de Watch Mode |
| `npm run quality:gate:auto` | Ejecuta la puerta de calidad automatizada |
| `npm run quality:gate:release` | Ejecuta la puerta de calidad de release |
| `npm run driver:build-sysvad` | Compila el controlador de audio virtual SYSVAD |
| `npm run driver:install` | Instala el controlador de desarrollo |
| `npm run driver:test` | Sondea el estado del controlador de desarrollo |
| `npm run driver:uninstall` | Desinstala el controlador de desarrollo |
| `npm run release:prepare` | Ejecuta el pipeline de preparación de release |

## Arquitectura del sistema

```text
┌────────────────────────────────────────────────────────────┐
│ 1. Desktop Shell                                            │
│    Tauri 2 + React 19 + TypeScript 6 + Vite 8/Rolldown      │
│    Ventana principal, superposición de subtítulos, rutas,   │
│    ajustes, diagnóstico, páginas de provider                │
├────────────────────────────────────────────────────────────┤
│ 2. Rust Core Runtime                                        │
│    Tauri commands/events, orquestación de sesiones,         │
│    almacenamiento, diagnóstico, integración de bandeja       │
├────────────────────────────────────────────────────────────┤
│ 3. Audio Layer                                              │
│    WASAPI + cpal + rodio, captura sistema/micrófono, VAD,   │
│    segmentación, mezcla                                     │
├────────────────────────────────────────────────────────────┤
│ 4. AI Gateway                                               │
│    reqwest + tungstenite, providers ASR / Translation / TTS  │
│    Plantillas DashScope y compatibles OpenAI, sondas, errores│
├────────────────────────────────────────────────────────────┤
│ 5. Native Bridge Service                                    │
│    Rust sidecar, WASAPI, Named Pipe IPC, tramas de audio,   │
│    IOCTL del controlador                                    │
├────────────────────────────────────────────────────────────┤
│ 6. Driver / Installer                                       │
│    Controlador virtual SYSVAD WaveRT, instalación, rollback,│
│    reparación y sondeo de salud                             │
└────────────────────────────────────────────────────────────┘
```

## Estructura de directorios

```text
omni-translate/
├── apps/
│   ├── desktop/                    # Aplicación de escritorio Tauri
│   │   ├── src/                    # Frontend React
│   │   │   ├── components/         # Componentes UI compartidos
│   │   │   ├── i18n/               # Recursos de locale UI para 20 idiomas
│   │   │   ├── pages/              # Páginas de sesión, rutas, provider, glosario, ajustes y diagnóstico
│   │   │   ├── runtime/            # Adaptadores frontend runtime/IPC
│   │   │   ├── schema/             # Contratos y tipos TypeScript
│   │   │   └── stores/             # Estado Zustand
│   │   └── src-tauri/              # Rust desktop shell
│   │       └── src/
│   │           ├── audio/          # Motor de audio, STT, TTS, rutas de traducción, providers en tiempo real
│   │           ├── bridge/         # Instalación de Bridge/controlador y contratos IPC
│   │           ├── diagnostics/    # Logs, trazas, estado de diagnóstico
│   │           ├── provider/       # AI Gateway, plantillas provider, transporte HTTP/WS
│   │           ├── runtime/        # Ventanas, bandeja, estado runtime
│   │           └── storage/        # Repositorio SQLite y gestión de credenciales
│   └── bridge-service-native/      # Rust Native Bridge Service, única implementación de puente de producción
├── drivers/
│   └── windows-virtual-mic/        # Controlador de audio virtual SYSVAD WaveRT
│       ├── include/                # ABI IOCTL compartida Driver/Bridge
│       ├── package/                # Metadatos del paquete del controlador
│       └── sysvad/                 # Fuente del controlador modificada desde el ejemplo SYSVAD de Microsoft
├── scripts/
│   ├── development/                # Scripts de inicio de desarrollo
│   ├── diagnostics/                # Herramientas de diagnóstico
│   ├── installer/                  # Compilación, instalación, desinstalación, reparación y sondeo del controlador
│   ├── release/                    # Verificación de release, manifest, empaquetado, manifest de firma
│   └── testing/                    # Pruebas, cobertura, puertas de calidad, enlaces Watch Mode
├── docs/                           # Documentación de arquitectura, calidad y proyecto, referencias provider/API
└── artifacts/                      # Salidas de compilación, logs y salidas de diagnóstico
```

## Flujos principales

### Traducción entrante (escenarios de visualización/subtítulos)

```text
Audio del sistema
  → Controlador de audio virtual / captura WASAPI
  → Native Bridge Service
  → Desktop Rust Audio Layer
  → VAD / segmentación
  → ASR
  → Translation Provider
  → Renderizado de subtítulos (ventana principal + superposición)
  → TTS opcional
  → Altavoz local / salida de monitorización
```

### Traducción saliente (escenarios de sala de voz/reunión/juego)

```text
Micrófono
  → Desktop Rust Audio Layer
  → VAD / segmentación
  → ASR
  → Translation Provider
  → TTS
  → Native Bridge Service
  → Controlador de audio virtual
  → La aplicación de destino lee el micrófono virtual / endpoint virtual
```

### Latencia y modos degradados

- Los subtítulos y la voz doblada son resultados de planificación separados; los subtítulos se confirman primero.
- Cuando la latencia del provider supera el presupuesto, se emite `latency-high`, los subtítulos continúan y TTS pasa al estado deferred/queued.
- Cuando el sondeo del provider marca un provider como no apto para tiempo real, la voz doblada se desactiva de forma predeterminada y la ruta con prioridad de subtítulos permanece activa.
- Los fallos del controlador o del Bridge no bloquean el arranque de la aplicación; los subtítulos, la reproducción local y el diagnóstico deben seguir disponibles en modo degradado.

## Pila tecnológica

| Capa | Tecnología |
| --- | --- |
| Frontend | React 19.2.x, TypeScript 6.0.x, Vite 8.x, Rolldown, CSS |
| Shell de escritorio | Tauri 2.x, `@tauri-apps/api`, `@tauri-apps/cli` |
| Estado y rutas | Zustand 5.x, react-router-dom 7.x |
| Internacionalización | i18next 26.x, react-i18next 17.x, i18next-browser-languagedetector |
| Pruebas frontend | Vitest 4.x, jsdom 29.x, ESLint 10.x |
| Runtime Rust | Rust 2021, Serde, Tauri commands/events |
| Red de provider | reqwest 0.13, tungstenite 0.29, rustls |
| Almacenamiento y credenciales | rusqlite 0.40 bundled SQLite, keyring 4, Windows Credential Manager |
| Audio | cpal 0.17, rodio 0.22, wasapi 0.23, hound, minimp3 |
| APIs del sistema | windows-sys 0.61 |
| Native Bridge | Rust sidecar, WASAPI, Named Pipe, IOCTL ABI |
| Controlador | Controlador de audio virtual Windows SYSVAD WaveRT |
| Scripts | PowerShell, scripts Node.js de release y pruebas |

## Contratos y límites de datos

El proyecto mantiene actualmente cuatro áreas de contratos congelados:

1. **Provider Contract**: metadatos de provider, referencias de autenticación, parámetros de solicitud, eventos de streaming, estructuras de error y resultados de sondeo.
2. **Audio Contract**: audio del sistema, micrófono, tramas PCM, segmentos, mezcla, compensación de latencia y estado push-to-talk.
3. **Driver Bridge Contract**: inicialización, tramas de audio, consultas de estado, eventos de error y protocolo de apagado entre Desktop, Native Bridge y el controlador.
4. **OBS Integration Contract**: límite de conexión y salida reservado para futura compatibilidad con superposición de subtítulos OBS y disparadores de escena.

La configuración estructurada usa SQLite como fuente principal de verdad. Las credenciales sensibles se almacenan en Windows Credential Manager. Los logs, cachés, paquetes de glosarios y archivos de audio temporales se mantienen en directorios separados.

## Calidad y pruebas

- `npm run verify:desktop`: lint, typecheck, test y build del frontend de escritorio.
- `npm run test:desktop-shell`: pruebas del backend Rust de Tauri.
- `npm run test:bridge-service-native`: pruebas Rust del Native Bridge.
- `npm run test:contracts`: verificación de contratos congelados en TypeScript/Rust/scripts.
- `npm run quality:gate:auto`: puerta de calidad automatizada.
- `npm run quality:gate:release`: puerta de calidad de release con puntos de entrada de verificación manual.
- `npm run test:watch-mode-report` / `npm run test:watch-mode-live:*`: informes Watch Mode, evidencias y puntos de entrada de pruebas de enlace real.

## Desarrollo

### Desarrollo frontend

Usa `npm run dev:desktop` para desarrollar el frontend en un navegador. En entornos que no son Tauri, la capa runtime devuelve datos mock para poder revisar páginas e interacciones sin instalar el controlador ni iniciar el backend Rust.

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

### Desarrollo del controlador

Compilar el controlador requiere Visual Studio 2022 + WDK. Instalar el controlador de desarrollo requiere privilegios de administrador y el modo TESTSIGNING.

```bash
npm run driver:build-sysvad
npm run driver:install
npm run driver:test
npm run driver:uninstall
```

## Licencia

Este proyecto tiene licencia privada. Todos los derechos reservados.
