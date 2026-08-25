# apps/desktop 组件说明

桌面端应用（Tauri 2 + React + Vite），包含两层：

- 前端层：`src/`、`index.html`、`overlay.html`、`vite.config.ts` 等（TypeScript/React）
- 桌面壳层：`src-tauri/`（Rust，Tauri 后端）

## 验证入口（在仓库根目录运行）

| 改动范围 | 验证命令 |
| --- | --- |
| 前端代码 | `npm run verify:desktop`（lint + tsc + vitest + 构建）；PR CI 另行强制覆盖率门禁与架构边界审计，本地对应 `npm run coverage:gate`（首次需先 `npm run coverage:tooling`）与 `npm run audit:architecture` |
| `src-tauri` Rust 代码 | `npm run test:desktop-shell`；仅编译检查用 `npm run check:desktop-shell` |
| 涉及跨进程契约（事件/命令/协议） | 额外运行 `npm run test:contracts` |

## 测试基建：src/test-utils（写组件/runtime 测试前先看这里）

新增组件或 runtime 测试前，先检查 [src/test-utils](src/test-utils) 是否已有可复用的 harness，不要在测试文件内重写挂载/mock 样板。

**导出约定：不提供桶导出（barrel），一律使用深路径导入**（如 `import { registerDomHarness } from '../test-utils/component-test-harness'`）。多个模块被 hoisted 的 `vi.mock` 工厂通过动态 import 深路径引用，必须保持各模块依赖图最小。

各模块适用场景：

| 模块 | 适用场景 |
| --- | --- |
| [component-test-harness](src/test-utils/component-test-harness.ts) | 组件/hook DOM 测试首选：`registerDomHarness()` 在 describe/文件级注册 act 环境、container、concurrent root 的 beforeEach/afterEach，支持 `fakeTimers`/`setup`/`cleanup` 选项 |
| [fake-bridge-dom-harness](src/test-utils/fake-bridge-dom-harness.ts) | 组件测试要走真实 runtime 模块 + fake bridge 契约替身时用 `registerFakeBridgeDomHarness()`（组合 DOM harness、fake bridge 连接、Tauri desktop-api、store 播种） |
| [fake-bridge-harness](src/test-utils/fake-bridge-harness.ts) | `vi.mock('@tauri-apps/api/core')` 的 fake-bridge 模块工厂与 `connectFakeBridge`/`disconnectFakeBridge`；无依赖，专供 hoisted mock 工厂动态 import |
| [runtime-test-harness](src/test-utils/runtime-test-harness.ts) | runtime 套件切换桌面边界：`enableTauriDesktopRuntime()` / `enablePreviewDesktopRuntime()` |
| [tauri-invoke-mock](src/test-utils/tauri-invoke-mock.ts) | runtime 单测标准做法：`invokeMock`/`emitMock`/`listenMock` 共享 spy 及配套 `vi.mock('@tauri-apps/api/...')` 模块工厂、`captureRegisteredListeners()` |
| [driver-runtime-mock](src/test-utils/driver-runtime-mock.ts) | 驱动管理套件对 `runtime/bridge-runtime` 的 mock 工厂与共享 spies |
| [driver-store-fixtures](src/test-utils/driver-store-fixtures.ts) | 驱动/桥接场景的 store 播种、runtime snapshot 补丁 fixture、`findButtonByText`（精确匹配） |
| [dom-interactions](src/test-utils/dom-interactions.ts) | act() 包裹的原生 DOM 交互：`click`/`inputText`/`selectValue`/`buttonByText`（包含匹配） |
| [react-root](src/test-utils/react-root.ts) | 需要手写 beforeEach/afterEach 的轻量挂载 `mountTestRoot()`；新测试优先用 `registerDomHarness` |
| [store-state](src/test-utils/store-state.ts) | `cloneStoreState()` 深克隆规范 store fixture；`setTauriRuntime()` 注入 Tauri/预览边界 |
| [store-seed](src/test-utils/store-seed.ts) | `seedRuntimeStore()` 一次性播种 config draft、runtime/audio snapshot 与通知，可传 mutator |
| [i18n-stub](src/test-utils/i18n-stub.ts) | `vi.mock('react-i18next')` 的无依赖 stub 工厂 `reactI18nextStub()` |

注意：`vi.mock` 工厂被 hoisted，不能闭包文件级变量，须在工厂内用 `await import('../test-utils/<模块>')` 动态深路径引用（各模块文件头注释附有示例）。

## 字幕翻译双路径（职责与启用条件）

两条 LLM 字幕翻译路径共用 [translation_scheduler.rs](src-tauri/src/audio/translation_scheduler.rs) 的调度核心（并发槽位补位、按 job/句子键去重、重试计数），只保留各自的取材与写回逻辑，请勿在任一路径内复制调度实现：

- **主路径 [translate.rs](src-tauri/src/audio/translate.rs)**（worker 名 `translate`）：经典（非 Omni）链路，由前端场景启动计划在所选实时模型不是 Omni 模型时追加 `translate-worker` 阶段启动（见 [sceneLaunchPlan.ts](src/pages/session/sceneLaunchPlan.ts)），整条 cue 一次翻译、流式增量写回，并发上限 3。
- **二次翻译路径 [subtitle_translate.rs](src-tauri/src/audio/subtitle_translate.rs)**（worker 名 `subtitle-translate`）：由 Rust 侧路由编排器在 Omni/openai-realtime 入站路由解析出 `secondary_subtitle_provider`（字幕回退策略为 secondary）时启动，将 cue 文本断句后逐句调度，支持强制预览（forced）/替换（replacement）优先级与 cue 修订重置，并发上限 8。

## 运行时排查（症状路由）

### 字幕译文延迟（原文已出、译文迟迟不出或很慢）

1. 看日志：`artifacts/diagnostics/logs/app.log`（相对仓库根目录）。
2. 确认翻译 worker 存活：搜索“翻译 Worker 心跳”日志（来自 [translate.rs](src-tauri/src/audio/translate.rs)，每 160 轮输出一次），字段含义：轮次（worker 存活且在轮询）、已处理 cue 数（翻译是否在推进）、队列深度（积压说明消费跟不上产生）、调度排队/进行中（共享调度器的排队与在途请求数）。若完全无心跳，先查“翻译 Worker 首轮配置”日志确认 provider 配置是否完整。
3. 看单 cue 耗时：每条“翻译完成，cue=…，耗时=…ms”日志即 provider 段（发起请求到收到完整译文）的 per-cue 耗时，可离线对照诊断面板的首译延迟指标（FirstTranslationLatencyTracker 样本）。
4. 区分 provider 段与本地管线段：用 [scripts/diagnostics/README.md](../../scripts/diagnostics/README.md) 中的 `omni-benchmark` 对同一段音频跑基准，得到纯 provider 段耗时基线；若 app.log 中 per-cue 耗时 ≈ 基准值，瓶颈在 provider（换模型/网络）；若明显大于基准值或心跳显示队列持续积压，瓶颈在本地管线（断句/轮询/并发上限）。

## 边界约束

- 前端与 Rust 壳之间只通过 Tauri 命令/事件通信，契约变更必须同步两侧并通过契约校验。
- 不要在本目录内直接调用 `apps/bridge-service-native` 的内部实现，只依赖既定协议。
