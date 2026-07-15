# Uncommitted Change Audit

本审计记录 `<repository-root>` 当前未提交重构工作树的收口结论，日期为 2026-07-15。

## Review Status

- [x] Group A：Native Bridge、Audio、Driver、Diagnostics
- [x] Group B：Desktop TypeScript、React、Runtime、Provider
- [x] Group C：Tauri Rust Provider、Storage、Benchmark
- [x] Group D：Scripts、CI、Docs、Metadata
- [x] 所有工作树文件已分类，未分类文件为 0
- [x] 编译、功能测试、契约、i18n、前端覆盖率和严格架构审计完成

## Change Groups

### Group A：Audio / Bridge

- Audio engine、events、speech、subtitle translation、Omni session 已按设备、路由、调度、协议和 worker 生命周期拆分。
- Native Bridge Windows 实现已按捕获/驱动 I/O 与订阅/播放职责拆分。
- Bridge 控制消息、Named Pipe、PCM 帧布局、IOCTL、事件名称和错误契约保持不变。

### Group B：React / Provider / Desktop API

- 6 个页面入口已变为薄 `*Page.tsx`，实现位于对应 `*Screen.tsx` 和职责子目录。
- Provider gateway 已拆为认证、模型、传输、路由、OpenAI、DashScope、探测和实时音频模块。
- 页面运行时访问统一经 Desktop API v2 Context；API v2 服务与原生窗口适配器已有契约测试。
- 前端单元覆盖率排除应用组合根、旧 bootstrap 协调器和纯类型 schema；这些属于集成或编译期边界，API v2 与可独立测试产品逻辑仍纳入覆盖率。

### Group C：Storage / Benchmark / Tauri Infrastructure

- Repository 已拆分 schema、JSON merge、快照服务、持久化对象和持久化实现。
- Benchmark 已拆分运行器、事件解析和报告汇总。
- API v2 command、Storage service 和 Tauri 配置入口均已接入当前模块树。

### Group D：Quality Infrastructure

- CI 增加契约与架构边界检查。
- `audit-architecture-boundaries.mjs` 严格模式当前为零违规。
- `audit-worktree-groups.mjs` 当前可分类全部工作树变更。
- Coverage 脚本按 native exit code 判断成功，避免 Windows PowerShell 将普通 stderr 警告误判为失败。

## Resolved Issues

### Bridge warnings

- Status：Resolved
- Evidence：`npm run check:bridge-service-native` 无编译错误；捕获和播放职责已进入独立文件。

### Contract README dependency

- Status：Resolved
- Evidence：`npm run test:contracts` 对协议 `2026-06-02-loopback-v2` 通过。

### i18n structural coverage

- Status：Resolved
- Evidence：全部 locale 结构覆盖率 100%，无 missing、empty 或 placeholder mismatch。

### Architecture violations

- Status：Resolved
- Evidence：严格审计从 15 项降至 9 项，最终降至 0；未提高 900/450 行阈值，也未增加豁免。

### Frontend coverage

- Status：Resolved
- Evidence：58 个测试文件、498 项测试；Statements 97.02%、Branches 91.70%、Functions 98.01%、Lines 97.38%，原阈值保持不变。

## Verification Log

- PASS：`npm run check:desktop`
- PASS：Desktop frontend tests — 58 files / 498 tests
- PASS：`npm run test:desktop-coverage`
- PASS：`npm run check:desktop-shell`
- PASS：`npm run test:desktop-shell` — 254 tests
- PASS：`npm run check:bridge-service-native`
- PASS：`npm run test:bridge-service-native` — 33 tests
- PASS：`npm run test:contracts`
- PASS：`npm run i18n:coverage`
- PASS：`npm run audit:architecture:strict` — 0 violations
- PASS：`npm run audit:worktree-groups` — 0 unclassified files
- PASS：`git diff --check`
- PARTIAL：管理员 `npm run quality:gate:auto` 通过 Desktop verify、contracts、frontend coverage 和 Desktop Rust 254 项测试，在全仓 Rust 100% 覆盖率断言处停止。

## Non-blocking Baseline Items

仓库覆盖率脚本对两个 Rust crate 强制 lines/functions/branches 100%。本轮已安装固定 nightly 与 `cargo-llvm-cov 0.8.6` 并取得实际报告：

- Desktop Rust：lines 45.77%
- Native Bridge：lines 21.35%、functions 31.05%、branches 14.18%

该差距覆盖大量平台 I/O、Tauri composition、WASAPI、Named Pipe、驱动与真实 WebSocket 路径，是独立的全产品测试建设任务，不是本轮模块拆分造成的回归。阈值未降低，本轮 Rust 源文件未从收集范围排除。

## Final Conclusion

- [x] 当前重构目标完成，严格架构审计零违规
- [x] 公共 API、事件协议、Bridge 帧协议、存储格式和 UI 行为保持兼容
- [x] 工作树变更均有明确分组与验证命令
- [x] `REFACTOR-TODO.md` 与本审计和当前实现一致

## Follow-up Object Refactor Status

2026-07-15 开始下一轮状态/生命周期对象收口。架构审计已扩展到 `.inc`、`*Screen.tsx` 和超长 Rust 函数，因此上一轮零违规基线不再代表当前增强规则的结果。

已完成并验证：

- Omni 会话的分散初始化状态已集中到 `OmniSessionRuntime`。
- Speech 调度去重和顺序缓存进入 `SpeechDispatchQueue`。
- Bridge 进程、Named Pipe 命令和 PCM 写入分别进入对应对象，现有调用方已接入。
- Diagnostics、Glossary 和 Audio Routing 已接入新的 controller/service 边界。
- `npm run check:desktop`、`npm run check:desktop-shell` 通过；相关前端测试 3 个文件、62 项通过。

当前增强审计仍失败，剩余项主要是 Omni 超长 worker、既有长 Rust worker 以及 6 个 `*Screen.tsx`。这些项目保持未完成，不使用阈值放宽或豁免伪造通过。

后续进展：Audio Routing、Glossary、Real-time Session 的 Screen 违规已分别通过组件、领域模块和日志服务提取消除；相关 TypeScript 检查与定向测试通过。增强审计由 14 项降至 11 项，当前剩余 3 个 Screen 与 8 个 Rust 项。

继续收口后，Diagnostics 的概览/报告/实时事件视图与 Overlay 的几何领域、样式数据、上下文菜单已移出 Screen；对应 72 项定向测试通过。增强审计当前为 9 项，仅剩 Providers Screen 和 8 个 Rust 项。

Bridge typed clients 已从 `bridge/ipc.rs` 迁入独立模块并保持原导入路径兼容，Desktop Rust 编译通过。增强审计由 9 项降至 8 项。

随后完成 STT 文本事件处理、watch mode 配置构建和字幕翻译 cue 循环的职责提取；每次变更后 Desktop Rust 均重新编译通过。增强严格审计现剩 5 项：`audio/engine/workers.rs::run_route_worker`、`audio/events/route_commands.rs::start_audio_route_inner`、`audio/omni/session_worker.inc` 的文件与 worker 两项，以及 `ProvidersScreen.tsx`。

继续完成 Route Commands 的 Omni 分支协调函数、Audio Engine 的 `device_initializer` 正式模块，以及 Providers Screen/Workspace 边界；Providers 类型检查和 71 项定向测试通过。Omni 已由 `.inc` 转为正式 `session_worker.rs`，Desktop Rust 再次编译通过。增强严格审计现仅剩 Omni 的文件体积与 `run_omni_worker` 两项，未调整阈值或增加豁免。

最终将 Omni 输入音频泵、首次连接/重连、ASR 事件、字幕/播放事件与 Socket 轮询分别迁入正式模块；`run_omni_worker` 和 `session_worker.rs` 均回到增强阈值内，`npm run audit:architecture:strict` 零违规。随后增加 `SpeechPlaybackEngine`、`CueTranslationLedger`、`TranslationResultWriter`、Providers workspace controller，并把 Session 停止顺序收口到现有 controller；Speech 29 项、字幕翻译 30 项、Providers 71 项、Session 33 项定向测试通过。

最终质量收口补充（2026-07-15）：

- 修复页面/组件拆分遗留的 ESLint 未使用导入与 Overlay ref props 误判，`verify:desktop` 通过。
- 新增薄页面入口与 Overlay 菜单行为测试，并覆盖 `DiagnosticsReportExporter` 的 JSON/TXT 导出适配；前端最终为 60 个测试文件、501 项测试。
- 前端覆盖率门禁通过：Statements 97.14%、Branches 92.22%、Functions 98.10%、Lines 97.54%，未调整阈值或排除本轮生产模块。
- 管理员 `npm run coverage:gate` 完成前端覆盖率和 Desktop Rust 254 项测试后，在既有 Rust 全仓 100% 行覆盖率断言处失败；本次报告 Desktop Rust lines 为 44.24%。该门禁缺口不通过降低阈值、增加排除或删除代码处理。
- 功能门禁仍全部通过：Desktop/Native Bridge 编译测试、契约、i18n、严格架构审计、工作树分组与 `git diff --check`。
