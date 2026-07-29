# apps/desktop 组件说明

桌面端应用（Tauri 2 + React + Vite），包含两层：

- 前端层：`src/`、`index.html`、`overlay.html`、`vite.config.ts` 等（TypeScript/React）
- 桌面壳层：`src-tauri/`（Rust，Tauri 后端）

## 验证入口（在仓库根目录运行）

| 改动范围 | 验证命令 |
| --- | --- |
| 前端代码 | `npm run verify:desktop`（lint + tsc + vitest + 构建） |
| `src-tauri` Rust 代码 | `npm run test:desktop-shell`；仅编译检查用 `npm run check:desktop-shell` |
| 涉及跨进程契约（事件/命令/协议） | 额外运行 `npm run test:contracts` |

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
