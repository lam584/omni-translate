# Omni Translate

<h4 align="center">
    <p>
        <b>简体中文</b> |
        <a href="i18n/README_en.md">English</a> |
        <a href="i18n/README_es.md">Español</a> |
        <a href="i18n/README_ar.md">العربية</a> |
        <a href="i18n/README_pt.md">Português</a> |
        <a href="i18n/README_ru.md">Русский</a> |
        <a href="i18n/README_hi.md">हिन्दी</a> |
        <a href="i18n/README_bn.md">বাংলা</a> |
        <a href="i18n/README_de.md">Deutsch</a> |
        <a href="i18n/README_id.md">Bahasa Indonesia</a> |
        <a href="i18n/README_ko.md">한국어</a> |
        <a href="i18n/README_fr.md">Français</a> |
        <a href="i18n/README_vi.md">Tiếng Việt</a> |
        <a href="i18n/README_ja.md">日本語</a> |
        <a href="i18n/README_te.md">తెలుగు</a> |
        <a href="i18n/README_ta.md">தமிழ்</a> |
        <a href="i18n/README_mr.md">मराठी</a> |
        <a href="i18n/README_th.md">ไทย</a> |
        <a href="i18n/README_fil.md">Filipino</a> |
        <a href="i18n/README_tr.md">Türkçe</a>
    </p>
</h4>

Omni Translate 面向 Windows 实时音频翻译场景，覆盖视频字幕翻译、游戏语音翻译、语音房/会议双向翻译等工作流。应用通过虚拟音频驱动、Native Bridge、Rust Core 和统一 AI Gateway 串联系统音频捕获、语音识别、LLM 翻译、语音合成、字幕渲染和音频回放。

## 功能亮点

- **实时字幕翻译**：捕获系统音频或麦克风音频，实时识别并显示翻译字幕，支持主窗口和悬浮窗展示。
- **字幕悬浮窗**：独立透明、无边框、置顶窗口，可覆盖在视频、游戏或会议软件上方。
- **双向语音翻译**：支持观看、游戏、语音房等路由模式，覆盖入站字幕/译音和出站虚拟麦克风输出。
- **虚拟音频驱动**：基于 SYSVAD WaveRT 的 Windows 虚拟音频驱动，通过 IOCTL/共享 ABI 与用户态桥接服务通信。
- **Rust Native Bridge**：`apps/bridge-service-native` 是当前唯一生产桥接实现，负责 WASAPI、命名管道 IPC、音频帧和驱动交互。
- **统一 AI Gateway**：模板化接入 DashScope 和 OpenAI 兼容接口，支持 HTTP、streaming HTTP 和 WebSocket 形态。
- **术语表管理**：支持领域术语包导入、导出、合并与优先级策略，并注入翻译提示词链路。
- **安全凭证管理**：API Key 等敏感信息存储在 Windows Credential Manager，不以明文写入业务配置。
- **诊断与质量门禁**：提供驱动健康探测、模型 Trace、日志导出、Watch Mode 真实链路测试和发布前质量门禁。
- **20 种界面语言**：当前界面语言资源覆盖 `ar`、`bn`、`de`、`en`、`es`、`fil`、`fr`、`hi`、`id`、`ja`、`ko`、`mr`、`pt`、`ru`、`ta`、`te`、`th`、`tr`、`vi`、`zh-CN`。

## 快速开始

### 环境要求

- **Node.js** >= 20
- **Rust stable**，edition 2021
- **Windows 10/11**
- **Visual Studio 2022 + WDK 10.0.26100**，仅在编译虚拟音频驱动时需要
- 开发驱动加载需要 Windows TESTSIGNING 模式；普通前端预览不需要驱动或管理员权限

### 安装与运行

```bash
# 1. 克隆仓库
git clone <repo-url>
cd omni-translate

# 2. 安装依赖
npm install

# 3. 启动前端浏览器预览模式
npm run dev:desktop

# 4. 启动完整 Tauri 桌面应用
npm run dev:desktop-shell
```

浏览器预览模式会自动使用 Mock runtime，适合 UI 开发和页面检查；完整桌面应用会启动 Tauri/Rust runtime，并在涉及驱动安装、修复等动作时触发提权流程。

### 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev:desktop` | 启动 React/Vite 前端开发服务器 |
| `npm run dev:desktop-shell` | 通过提权脚本启动完整 Tauri 桌面应用 |
| `npm run lint:desktop` | 运行桌面前端 ESLint |
| `npm run check:desktop` | TypeScript 类型检查 |
| `npm run build:desktop` | 构建前端产物 |
| `npm run check:desktop-shell` | 检查 Tauri Rust 后端 |
| `npm run build:desktop-shell` | 构建完整 Tauri 应用 |
| `npm run build:bridge-service-native` | 构建 Rust Native Bridge Service |
| `npm run test:all` | 运行全量测试入口 |
| `npm run test:contracts` | 校验冻结契约 |
| `npm run test:watch-mode-live:dry-run` | Watch Mode 真实链路 dry-run |
| `npm run quality:gate:auto` | 自动化质量门禁 |
| `npm run quality:gate:release` | 发布前质量门禁 |
| `npm run driver:build-sysvad` | 编译 SYSVAD 虚拟音频驱动 |
| `npm run driver:install` | 安装开发驱动 |
| `npm run driver:test` | 探测开发驱动状态 |
| `npm run driver:uninstall` | 卸载开发驱动 |
| `npm run release:prepare` | 执行发布准备流水线 |

## 系统架构

```text
┌────────────────────────────────────────────────────────────┐
│ 1. Desktop Shell                                            │
│    Tauri 2 + React 19 + TypeScript 6 + Vite 8/Rolldown      │
│    主窗口、字幕悬浮窗、路由、设置、诊断、Provider 页面         │
├────────────────────────────────────────────────────────────┤
│ 2. Rust Core Runtime                                        │
│    Tauri commands/events、会话编排、配置存储、诊断、托盘       │
├────────────────────────────────────────────────────────────┤
│ 3. Audio Layer                                              │
│    WASAPI + cpal + rodio，系统音频/麦克风捕获、VAD、分句、混音 │
├────────────────────────────────────────────────────────────┤
│ 4. AI Gateway                                               │
│    reqwest + tungstenite，ASR / Translation / TTS Provider   │
│    DashScope 与 OpenAI 兼容接口模板、能力探测、错误归一化     │
├────────────────────────────────────────────────────────────┤
│ 5. Native Bridge Service                                    │
│    Rust sidecar，WASAPI、命名管道 IPC、音频帧、驱动 IOCTL      │
├────────────────────────────────────────────────────────────┤
│ 6. Driver / Installer                                       │
│    SYSVAD WaveRT 虚拟音频驱动、安装、回滚、修复和健康探测      │
└────────────────────────────────────────────────────────────┘
```

## 目录结构

```text
omni-translate/
├── apps/
│   ├── desktop/                    # Tauri 桌面应用
│   │   ├── src/                    # React 前端
│   │   │   ├── components/         # 通用 UI 组件
│   │   │   ├── i18n/               # 20 种界面语言资源
│   │   │   ├── pages/              # 会话、路由、Provider、术语、设置、诊断页面
│   │   │   ├── runtime/            # 前端 runtime/IPC 适配层
│   │   │   ├── schema/             # TypeScript 契约与类型
│   │   │   └── stores/             # Zustand 状态
│   │   └── src-tauri/              # Rust desktop shell
│   │       └── src/
│   │           ├── audio/          # 音频引擎、STT、TTS、翻译路由、实时 Provider
│   │           ├── bridge/         # Bridge/驱动安装与 IPC 契约
│   │           ├── diagnostics/    # 日志、Trace、诊断状态
│   │           ├── provider/       # AI Gateway、Provider 模板、HTTP/WS 传输
│   │           ├── runtime/        # 窗口、托盘、运行时状态
│   │           └── storage/        # SQLite 仓库与凭据管理
│   └── bridge-service-native/      # Rust Native Bridge Service，唯一生产桥接实现
├── drivers/
│   └── windows-virtual-mic/        # SYSVAD WaveRT 虚拟音频驱动
│       ├── include/                # Driver/Bridge 共享 IOCTL ABI
│       ├── package/                # 驱动包元数据
│       └── sysvad/                 # 基于 Microsoft SYSVAD 示例修改的驱动源码
├── scripts/
│   ├── development/                # 开发启动脚本
│   ├── diagnostics/                # 诊断工具
│   ├── installer/                  # 驱动构建、安装、卸载、修复、探测
│   ├── release/                    # 发布校验、manifest、打包、签名清单
│   └── testing/                    # 测试、覆盖率、质量门禁、Watch Mode 链路
├── docs/                           # 架构、质量、项目文档和 Provider/API 资料
└── artifacts/                      # 构建产物、日志和诊断输出
```

## 核心流程

### 入站翻译（观看/字幕场景）

```text
系统音频
  → 虚拟音频驱动 / WASAPI 捕获
  → Native Bridge Service
  → Desktop Rust Audio Layer
  → VAD / 分句
  → ASR
  → Translation Provider
  → 字幕渲染（主窗口 + 悬浮窗）
  → 可选 TTS
  → 本地扬声器 / 监听输出
```

### 出站翻译（语音房/会议/游戏场景）

```text
麦克风
  → Desktop Rust Audio Layer
  → VAD / 分句
  → ASR
  → Translation Provider
  → TTS
  → Native Bridge Service
  → 虚拟音频驱动
  → 目标应用读取虚拟麦克风/虚拟端点
```

### 延迟与降级策略

- 字幕和译音是独立调度结果，字幕优先提交。
- Provider 延迟超预算时触发 `latency-high`，字幕继续输出，TTS 进入 deferred/queued 状态。
- Provider 探测不适合实时使用时，默认关闭译音叠加，仅保留字幕优先链路。
- 驱动或 Bridge 异常不阻塞应用启动；字幕、本地播放和诊断页面应以降级模式继续可用。

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 前端 | React 19.2.x、TypeScript 6.0.x、Vite 8.x、Rolldown、CSS |
| 桌面壳 | Tauri 2.x、`@tauri-apps/api`、`@tauri-apps/cli` |
| 状态与路由 | Zustand 5.x、react-router-dom 7.x |
| 国际化 | i18next 26.x、react-i18next 17.x、i18next-browser-languagedetector |
| 前端测试 | Vitest 4.x、jsdom 29.x、ESLint 10.x |
| Rust runtime | Rust 2021、Serde、Tauri commands/events |
| Provider 网络层 | reqwest 0.13、tungstenite 0.29、rustls |
| 存储与凭据 | rusqlite 0.40 bundled SQLite、keyring 4、Windows Credential Manager |
| 音频 | cpal 0.17、rodio 0.22、wasapi 0.23、hound、minimp3 |
| 系统接口 | windows-sys 0.61 |
| Native Bridge | Rust sidecar、WASAPI、Named Pipe、IOCTL ABI |
| 驱动 | Windows SYSVAD WaveRT 虚拟音频驱动 |
| 脚本 | PowerShell、Node.js release/testing scripts |

## 契约与数据边界

项目当前重点维护四类冻结契约：

1. **Provider Contract**：Provider 元数据、鉴权引用、请求参数、流式事件、错误结构和能力探测结果。
2. **Audio Contract**：系统音频、麦克风、PCM 帧、分句、混音、延迟补偿和 Push-to-talk 状态。
3. **Driver Bridge Contract**：Desktop、Native Bridge 和驱动之间的初始化、音频帧、状态查询、错误事件和关闭协议。
4. **OBS Integration Contract**：为后续 OBS 字幕叠加和场景触发预留的连接与输出边界。

结构化配置以 SQLite 为主真相源；敏感凭据存入 Windows Credential Manager；日志、缓存、术语包和临时音频按目录分离。

## 质量与测试

- `npm run verify:desktop`：桌面前端 lint、typecheck、test、build。
- `npm run test:desktop-shell`：Tauri Rust 后端测试。
- `npm run test:bridge-service-native`：Native Bridge Rust 测试。
- `npm run test:contracts`：校验 TypeScript/Rust/脚本侧冻结契约。
- `npm run quality:gate:auto`：自动化质量门禁。
- `npm run quality:gate:release`：发布前质量门禁，包含手工验证入口。
- `npm run test:watch-mode-report` / `npm run test:watch-mode-live:*`：Watch Mode 报告、证据和真实链路测试入口。

## 开发说明

### 前端开发

前端可直接使用 `npm run dev:desktop` 在浏览器中开发。非 Tauri 环境下 runtime 层返回 Mock 数据，便于不安装驱动、不启动 Rust 后端时检查页面和交互。

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

### 驱动开发

驱动编译需要 Visual Studio 2022 + WDK。开发驱动安装需要管理员权限和 TESTSIGNING 模式。

```bash
npm run driver:build-sysvad
npm run driver:install
npm run driver:test
npm run driver:uninstall
```

## 许可证

本项目采用 [Apache License 2.0](LICENSE) 许可证。
