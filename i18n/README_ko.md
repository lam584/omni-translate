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
        <b>한국어</b> |
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

Omni Translate는 Windows 실시간 오디오 번역 시나리오를 위한 데스크톱 애플리케이션입니다. 비디오 자막 번역, 게임 음성 번역, 음성방/회의 양방향 번역 같은 워크플로를 지원합니다. 앱은 가상 오디오 드라이버, Native Bridge, Rust Core, 통합 AI Gateway를 연결해 시스템 오디오 캡처, 음성 인식, LLM 번역, 음성 합성, 자막 렌더링, 오디오 재생을 이어 줍니다.

## 주요 기능

- **실시간 자막 번역**: 시스템 오디오 또는 마이크 오디오를 캡처하고, 실시간으로 인식해 번역 자막을 표시하며, 메인 창과 플로팅 창 표시를 지원합니다.
- **자막 플로팅 창**: 독립적인 투명, 무테, 항상 위 창으로 비디오, 게임 또는 회의 소프트웨어 위에 겹쳐 놓을 수 있습니다.
- **양방향 음성 번역**: 시청, 게임, 음성방 등의 라우팅 모드를 지원하며, 인바운드 자막/번역 음성과 아웃바운드 가상 마이크 출력을 모두 다룹니다.
- **가상 오디오 드라이버**: SYSVAD WaveRT 기반 Windows 가상 오디오 드라이버이며 IOCTL/공유 ABI를 통해 사용자 모드 브리지 서비스와 통신합니다.
- **Rust Native Bridge**: `apps/bridge-service-native`는 현재 유일한 프로덕션 브리지 구현이며 WASAPI, Named Pipe IPC, 오디오 프레임, 드라이버 연동을 담당합니다.
- **통합 AI Gateway**: 템플릿 기반 DashScope 및 OpenAI 호환 인터페이스를 통합하고 HTTP, streaming HTTP, WebSocket 형태를 지원합니다.
- **용어집 관리**: 도메인 용어 패키지의 가져오기, 내보내기, 병합, 우선순위 정책을 지원하며 번역 프롬프트 경로에 주입합니다.
- **안전한 자격 증명 관리**: API Key 등 민감한 정보는 Windows Credential Manager에 저장하고 비즈니스 설정에 평문으로 쓰지 않습니다.
- **진단 및 품질 게이트**: 드라이버 상태 프로브, 모델 Trace, 로그 내보내기, Watch Mode 실제 링크 테스트, 릴리스 전 품질 게이트를 제공합니다.
- **20개 UI 언어**: 현재 UI 언어 리소스는 `ar`, `bn`, `de`, `en`, `es`, `fil`, `fr`, `hi`, `id`, `ja`, `ko`, `mr`, `pt`, `ru`, `ta`, `te`, `th`, `tr`, `vi`, `zh-CN`을 포함합니다.

## 빠른 시작

### 요구 사항

- **Node.js** >= 20
- **Rust stable**, edition 2021
- **Windows 10/11**
- **Visual Studio 2022 + WDK 10.0.26100**, 가상 오디오 드라이버를 빌드할 때만 필요
- 개발 드라이버 로드에는 Windows TESTSIGNING 모드가 필요합니다. 일반 프런트엔드 미리보기에는 드라이버나 관리자 권한이 필요하지 않습니다.

### 설치 및 실행

```bash
# 1. 저장소 복제
git clone <repo-url>
cd omni-translate

# 2. 의존성 설치
npm install

# 3. 프런트엔드 브라우저 미리보기 시작
npm run dev:desktop

# 4. 전체 Tauri 데스크톱 앱 시작
npm run dev:desktop-shell
```

브라우저 미리보기 모드는 자동으로 Mock runtime을 사용하므로 UI 개발과 페이지 확인에 적합합니다. 전체 데스크톱 앱은 Tauri/Rust runtime을 시작하며 드라이버 설치, 복구 같은 작업이 관련될 때만 권한 상승 흐름을 실행합니다.

### 주요 명령

| 명령 | 설명 |
| --- | --- |
| `npm run dev:desktop` | React/Vite 프런트엔드 개발 서버 시작 |
| `npm run dev:desktop-shell` | 권한 상승 스크립트를 통해 전체 Tauri 데스크톱 앱 시작 |
| `npm run lint:desktop` | 데스크톱 프런트엔드 ESLint 실행 |
| `npm run check:desktop` | TypeScript 타입 검사 실행 |
| `npm run build:desktop` | 프런트엔드 산출물 빌드 |
| `npm run check:desktop-shell` | Tauri Rust 백엔드 검사 |
| `npm run build:desktop-shell` | 전체 Tauri 앱 빌드 |
| `npm run build:bridge-service-native` | Rust Native Bridge Service 빌드 |
| `npm run test:all` | 전체 테스트 진입점 실행 |
| `npm run test:contracts` | 동결 계약 검증 |
| `npm run test:watch-mode-live:dry-run` | Watch Mode 실제 링크 dry-run 실행 |
| `npm run quality:gate:auto` | 자동화 품질 게이트 실행 |
| `npm run quality:gate:release` | 릴리스 품질 게이트 실행 |
| `npm run driver:build-sysvad` | SYSVAD 가상 오디오 드라이버 빌드 |
| `npm run driver:install` | 개발 드라이버 설치 |
| `npm run driver:test` | 개발 드라이버 상태 프로브 |
| `npm run driver:uninstall` | 개발 드라이버 제거 |
| `npm run release:prepare` | 릴리스 준비 파이프라인 실행 |

## 시스템 아키텍처

```text
┌────────────────────────────────────────────────────────────┐
│ 1. Desktop Shell                                            │
│    Tauri 2 + React 19 + TypeScript 6 + Vite 8/Rolldown      │
│    메인 창, 자막 플로팅 창, 라우팅, 설정, 진단, Provider 페이지 │
├────────────────────────────────────────────────────────────┤
│ 2. Rust Core Runtime                                        │
│    Tauri commands/events, 세션 오케스트레이션, 설정 저장,     │
│    진단, 트레이 통합                                        │
├────────────────────────────────────────────────────────────┤
│ 3. Audio Layer                                              │
│    WASAPI + cpal + rodio, 시스템 오디오/마이크 캡처, VAD,     │
│    분절, 믹싱                                               │
├────────────────────────────────────────────────────────────┤
│ 4. AI Gateway                                               │
│    reqwest + tungstenite, ASR / Translation / TTS Provider   │
│    DashScope 및 OpenAI 호환 템플릿, 기능 프로브, 오류 정규화  │
├────────────────────────────────────────────────────────────┤
│ 5. Native Bridge Service                                    │
│    Rust sidecar, WASAPI, Named Pipe IPC, 오디오 프레임,       │
│    드라이버 IOCTL                                           │
├────────────────────────────────────────────────────────────┤
│ 6. Driver / Installer                                       │
│    SYSVAD WaveRT 가상 오디오 드라이버, 설치, 롤백, 복구,      │
│    상태 프로브                                              │
└────────────────────────────────────────────────────────────┘
```

## 디렉터리 구조

```text
omni-translate/
├── apps/
│   ├── desktop/                    # Tauri 데스크톱 애플리케이션
│   │   ├── src/                    # React 프런트엔드
│   │   │   ├── components/         # 공통 UI 컴포넌트
│   │   │   ├── i18n/               # 20개 UI 언어 리소스
│   │   │   ├── pages/              # 세션, 라우팅, Provider, 용어, 설정, 진단 페이지
│   │   │   ├── runtime/            # 프런트엔드 runtime/IPC 어댑터 계층
│   │   │   ├── schema/             # TypeScript 계약 및 타입
│   │   │   └── stores/             # Zustand 상태
│   │   └── src-tauri/              # Rust desktop shell
│   │       └── src/
│   │           ├── audio/          # 오디오 엔진, STT, TTS, 번역 라우팅, 실시간 Provider
│   │           ├── bridge/         # Bridge/드라이버 설치 및 IPC 계약
│   │           ├── diagnostics/    # 로그, Trace, 진단 상태
│   │           ├── provider/       # AI Gateway, Provider 템플릿, HTTP/WS 전송
│   │           ├── runtime/        # 창, 트레이, 런타임 상태
│   │           └── storage/        # SQLite 저장소 및 자격 증명 관리
│   └── bridge-service-native/      # Rust Native Bridge Service, 유일한 프로덕션 브리지 구현
├── drivers/
│   └── windows-virtual-mic/        # SYSVAD WaveRT 가상 오디오 드라이버
│       ├── include/                # Driver/Bridge 공유 IOCTL ABI
│       ├── package/                # 드라이버 패키지 메타데이터
│       └── sysvad/                 # Microsoft SYSVAD 예제를 수정한 드라이버 소스
├── scripts/
│   ├── development/                # 개발 시작 스크립트
│   ├── diagnostics/                # 진단 도구
│   ├── installer/                  # 드라이버 빌드, 설치, 제거, 복구, 프로브
│   ├── release/                    # 릴리스 검증, manifest, 패키징, 서명 목록
│   └── testing/                    # 테스트, 커버리지, 품질 게이트, Watch Mode 링크
├── docs/                           # 아키텍처, 품질, 프로젝트 문서 및 Provider/API 자료
└── artifacts/                      # 빌드 산출물, 로그, 진단 출력
```

## 핵심 흐름

### 인바운드 번역(시청/자막 시나리오)

```text
시스템 오디오
  → 가상 오디오 드라이버 / WASAPI 캡처
  → Native Bridge Service
  → Desktop Rust Audio Layer
  → VAD / 분절
  → ASR
  → Translation Provider
  → 자막 렌더링(메인 창 + 플로팅 창)
  → 선택적 TTS
  → 로컬 스피커 / 모니터 출력
```

### 아웃바운드 번역(음성방/회의/게임 시나리오)

```text
마이크
  → Desktop Rust Audio Layer
  → VAD / 분절
  → ASR
  → Translation Provider
  → TTS
  → Native Bridge Service
  → 가상 오디오 드라이버
  → 대상 앱이 가상 마이크 / 가상 엔드포인트를 읽음
```

### 지연 시간 및 성능 저하 전략

- 자막과 번역 음성은 별도의 스케줄링 결과이며 자막이 먼저 커밋됩니다.
- Provider 지연 시간이 예산을 초과하면 `latency-high`가 발생하고, 자막은 계속 출력되며 TTS는 deferred/queued 상태로 이동합니다.
- Provider 프로브가 실시간 사용에 부적합하다고 판단하면 번역 음성 오버레이는 기본적으로 비활성화되고 자막 우선 경로만 유지됩니다.
- 드라이버 또는 Bridge 오류는 앱 시작을 차단하지 않습니다. 자막, 로컬 재생, 진단 페이지는 성능 저하 모드에서 계속 사용할 수 있어야 합니다.

## 기술 스택

| 계층 | 기술 |
| --- | --- |
| 프런트엔드 | React 19.2.x, TypeScript 6.0.x, Vite 8.x, Rolldown, CSS |
| 데스크톱 셸 | Tauri 2.x, `@tauri-apps/api`, `@tauri-apps/cli` |
| 상태 및 라우팅 | Zustand 5.x, react-router-dom 7.x |
| 국제화 | i18next 26.x, react-i18next 17.x, i18next-browser-languagedetector |
| 프런트엔드 테스트 | Vitest 4.x, jsdom 29.x, ESLint 10.x |
| Rust runtime | Rust 2021, Serde, Tauri commands/events |
| Provider 네트워크 계층 | reqwest 0.13, tungstenite 0.29, rustls |
| 저장소 및 자격 증명 | rusqlite 0.40 bundled SQLite, keyring 4, Windows Credential Manager |
| 오디오 | cpal 0.17, rodio 0.22, wasapi 0.23, hound, minimp3 |
| 시스템 인터페이스 | windows-sys 0.61 |
| Native Bridge | Rust sidecar, WASAPI, Named Pipe, IOCTL ABI |
| 드라이버 | Windows SYSVAD WaveRT 가상 오디오 드라이버 |
| 스크립트 | PowerShell, Node.js release/testing scripts |

## 계약과 데이터 경계

프로젝트는 현재 네 가지 동결 계약 영역을 중점적으로 유지합니다.

1. **Provider Contract**: Provider 메타데이터, 인증 참조, 요청 매개변수, 스트리밍 이벤트, 오류 구조, 기능 프로브 결과.
2. **Audio Contract**: 시스템 오디오, 마이크, PCM 프레임, 분절, 믹싱, 지연 보정, Push-to-talk 상태.
3. **Driver Bridge Contract**: Desktop, Native Bridge, 드라이버 간 초기화, 오디오 프레임, 상태 조회, 오류 이벤트, 종료 프로토콜.
4. **OBS Integration Contract**: 향후 OBS 자막 오버레이 및 장면 트리거 지원을 위해 예약된 연결과 출력 경계.

구조화 설정은 SQLite를 주요 진실 원본으로 사용합니다. 민감한 자격 증명은 Windows Credential Manager에 저장합니다. 로그, 캐시, 용어집 패키지, 임시 오디오 파일은 디렉터리별로 분리됩니다.

## 품질 및 테스트

- `npm run verify:desktop`: 데스크톱 프런트엔드 lint, typecheck, test, build.
- `npm run test:desktop-shell`: Tauri Rust 백엔드 테스트.
- `npm run test:bridge-service-native`: Native Bridge Rust 테스트.
- `npm run test:contracts`: TypeScript/Rust/스크립트 측 동결 계약 검증.
- `npm run quality:gate:auto`: 자동화 품질 게이트.
- `npm run quality:gate:release`: 수동 검증 진입점을 포함한 릴리스 전 품질 게이트.
- `npm run test:watch-mode-report` / `npm run test:watch-mode-live:*`: Watch Mode 보고서, 증거, 실제 링크 테스트 진입점.

## 개발

### 프런트엔드 개발

프런트엔드는 `npm run dev:desktop`을 사용해 브라우저에서 직접 개발할 수 있습니다. Tauri가 아닌 환경에서는 runtime 계층이 Mock 데이터를 반환하므로 드라이버를 설치하거나 Rust 백엔드를 시작하지 않아도 페이지와 상호작용을 확인할 수 있습니다.

### Rust 데스크톱 셸

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

### 드라이버 개발

드라이버 빌드에는 Visual Studio 2022 + WDK가 필요합니다. 개발 드라이버 설치에는 관리자 권한과 TESTSIGNING 모드가 필요합니다.

```bash
npm run driver:build-sysvad
npm run driver:install
npm run driver:test
npm run driver:uninstall
```

## 라이선스

이 프로젝트는 비공개 라이선스(Private)를 사용합니다. 모든 권리는 보유됩니다.
