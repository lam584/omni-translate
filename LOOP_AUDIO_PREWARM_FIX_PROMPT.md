# Omni Translate 出站音频预热故障修复 Loop 提示词

你正在维护当前仓库中的 Windows 桌面应用。请以资深 Windows 音频架构师、Rust/Tauri 工程师和测试负责人身份，自主执行“调查 → 建模 → 修改 → 验证 → 复盘”的闭环，持续推进，直到下面定义的完成条件全部满足。不要只给建议或停在分析报告；你需要实际检查代码、收集证据、实施修复并运行验证。

## 当前故障

应用启动后的音频采集预热持续出现：

```text
预热初始化失败，将回退到点击时冷启动。
direction=outbound error=Windows returned an error: 找不到元素。 (0x80070490)
```

该错误来自：

- `apps/desktop/src-tauri/src/audio/engine/warm_route.rs`
- 调用链进入 `apps/desktop/src-tauri/src/audio/engine/device_initializer.rs::initialize_capture_route`
- `outbound` 应使用 WASAPI Capture 端点（通常为麦克风）
- 前端在启动空闲窗口通过 `scheduleCapturePrewarmAfterStartup` 调用 `prewarmRoutes`

`0x80070490` 是 Windows `ERROR_NOT_FOUND / Element not found`。不要把这个含义直接当作根因；必须查明它由哪一个 WASAPI/COM 调用返回、针对哪个设备、发生时设备拓扑和配置处于什么状态。

## 首要目标

从应用架构层面消除出站预热反复失败，并确保：

1. 有效且可用的麦克风配置能够稳定完成预热并在点击开始时复用。
2. 已删除、禁用、断连、切换或尚未就绪的端点不会让系统永久使用陈旧设备 ID。
3. 预热期间的设备变化、配置变化和并发调用不会产生失效句柄或错误归因。
4. 预热失败时仍能安全冷启动；冷启动必须重新解析当前设备，而不是机械复用预热时的失效选择。
5. 日志能明确指出失败阶段、请求设备 ID、实际设备 ID、端点状态、HRESULT 分类、重试/刷新/回退动作和最终结果。
6. 不靠吞掉错误、无限重试、固定 sleep、关闭预热或仅修改提示文案来“解决”。

## 首次使用与空配置的产品策略

把“首次使用时自动采用系统默认音频设备”作为正式产品行为，而不是偶然 fallback：

- `devices.inputDeviceId`、`outboundRoute.input.deviceId` 为空、缺失或为 `default` / `microphone-default` 时，语义统一为“跟随 Windows 当前默认通信录音设备”；建立 route 时再解析真实 MMDevice ID。
- `devices.outputDeviceId`、inbound 的系统输出来源及本地监听输出为空、缺失或为默认别名时，语义统一为“跟随 Windows 当前默认播放设备”。
- 首次加载配置后，在设备目录 ready 时完成一次规范化/补全。不要把某个机器相关的真实 MMDevice ID硬写进默认配置；持久化默认别名或明确的 selection mode（`follow-system-default`）更稳健。
- 音频路由 UI 必须提供并默认选中“系统默认麦克风”“系统默认扬声器”，同时显示当前解析到的真实设备名称。配置为空时不能显示“未选择”并阻止测试/启动。
- 若系统确实不存在任何可用 capture/render endpoint，则显示明确空状态和操作建议；不得把它伪装成已选默认设备，也不得无意义地反复预热。
- 设备列表或系统默认值变化后，跟随默认的 route 应重新解析；用户明确选择了固定设备时则尊重选择，只有设备失效才进入可观测的恢复策略。
- 兼容已有数据库中的空字段、旧默认别名和失效真实 ID，设计一次幂等迁移/运行时归一化，避免默认 JSON 被 SQLite 空值覆盖后重新制造空路由。

## 工作纪律

- 开始前阅读根目录 `AGENTS.md`，遵守仓库约束。
- 工作区可能已有用户改动。先运行 `git status --short`，不得覆盖、还原、格式化或顺手修改无关文件。
- Windows 中文文件按 UTF-8/实际编码谨慎处理；禁止格式化命令批量改文件，禁止用 PowerShell 批量修改文件。代码修改使用精确补丁。
- 优先使用 `rg` 定位代码。先读实现和测试，再修改。
- 每轮先记录事实、假设和验证方式。用证据淘汰假设，不凭直觉宣布根因。
- 若命令因权限失败，清楚报告需要的权限和具体命令；不要绕过安全边界。
- 不要因为一次测试通过就结束。必须完成重复运行和至少一种设备变化场景。

## 必查调用链与架构边界

完整追踪并画出实际调用链：

```text
App startup
  -> scheduleCapturePrewarmAfterStartup
  -> prewarmCaptureRoutesRuntime
  -> session_v2/prewarmRoutes
  -> audio_events::prewarm_capture_routes
  -> CaptureRouteWarmer::prewarm
  -> warm_route_thread
  -> initialize_capture_route
  -> DeviceEnumerator / endpoint selection
  -> IAudioClient creation and initialization
  -> event handle / buffer / IAudioCaptureClient
```

同时追踪点击开始后的冷启动和预热复用路径，检查这两条路径是否使用同一套设备解析、错误分类与生命周期规则。

重点检查：

- `RouteSpec::from_config` 如何生成 `requested_device_id`，空 ID、默认设备别名和真实 MMDevice ID 分别如何表示。
- 核对默认配置虽然使用 `microphone-default` / `system-output-default`，但持久化层的空字符串是否覆盖了这些默认值；核对前端是否把默认别名误判为“不在设备列表中”。
- `pick_device`、`find_device_by_id`、`wasapi_direction()`、`capture_direction()` 对 outbound 的方向是否始终正确。
- 启动时配置加载、设备枚举和预热调度的先后顺序；是否在 Windows Audio 服务或端点就绪前预热。
- 配置保存的设备 ID 是否可能来自旧设备、不同枚举方向、虚拟端点或上次启动。
- `CaptureRouteWarmer` 的 slot 是否可能在初始化线程已经退出后仍短暂留在 map 中；取消、替换、激活和配置更新是否竞态安全。
- COM apartment 初始化结果是否被忽略；线程亲和性和析构线程是否正确。
- 每一个可能产生 `0x80070490` 的调用：枚举器创建、按 ID 取设备、`get_id`、`get_iaudioclient`、`get_device_period`、`initialize_client`、`set_get_eventhandle`、`get_buffer_size`、`get_audiocaptureclient`。必须让日志或分层错误标出具体 stage。
- 当前 `AudioInitError` 只区分 AccessDenied、DeviceInUse、Unknown；评估并实现 `EndpointNotFound/DeviceInvalidated/ServiceNotReady` 等有实际恢复策略的分类，避免只做字符串装饰。
- 设备失效后是否应刷新 catalog、重新解析默认通信设备、有限退避重试，或回退到明确的可用 capture 端点。outbound 不得误用 render 端点回退策略。

## 假设清单（逐项证伪或确认）

至少调查这些假设，并在工作记录中标注证据：

1. 保存的 outbound 麦克风 MMDevice ID 已失效，`pick_device` 或后续激活返回 `0x80070490`。
2. 预热早于音频设备枚举/配置恢复完成，使用了过期快照。
3. 蓝牙、USB、虚拟声卡或默认通信设备在启动期发生 PnP 状态切换。
4. endpoint 能被枚举，但在 `Activate(IAudioClient)` 或 `Initialize` 前已被移除/禁用。
5. outbound 的设备选择方向或默认角色选择错误。
6. 同一物理设备被入站/出站预热、Bridge 或其他采集流程并发占用，引发竞态。
7. COM 初始化失败被 `.ok()` 吞掉，导致后续错误失真。
8. `wasapi` crate 的错误字符串丢失了调用阶段，现有重试分类因此无效。

## 实施原则

优先形成以下架构，而不是堆叠局部补丁：

- 建立单一的“设备解析 + 端点有效性校验”边界，预热与冷启动共用。
- 区分“用户明确选择的设备”和“跟随系统默认设备”。跟随默认值时应在每次建立 route 时解析当前默认端点，不能永久缓存某个历史 ID。
- 不要再仅用字符串是否等于设备列表中的真实 ID 判断 UI 可用性；默认别名应通过统一 resolver 得到当前 endpoint，或作为合法的特殊选项呈现。
- 对 endpoint-not-found/device-invalidated 采用有上限、可观测的恢复序列，例如：重新枚举 → 重新解析 → 短退避重试 → 合法回退；不可无限循环。
- 让初始化错误携带结构化上下文：`stage`、`direction`、`requested_device_id`、`effective_device_id`、`HRESULT`、`attempt`、`device_state`、`recovery_action`。
- 预热 slot 应有明确状态机，例如 `Initializing / Ready / Activating / Cancelled / Failed`，并保证失败 slot 可清理、可再次预热，不残留假就绪状态。
- 如果启动期 Windows 音频拓扑尚未稳定，使用由设备目录 readiness/变更通知驱动的重试优于盲目固定延迟；在项目能力范围内选择最小但正确的实现。
- 保持预热是优化项，但不能掩盖系统性错误。相同根因在冷启动路径也必须被正确恢复和呈现。

## 测试要求

先找出现有 Rust、TypeScript 和脚本测试入口，再补最小充分测试。至少覆盖：

- outbound 有效 capture device：预热成功、slot ready、点击后复用。
- 全新用户配置、字段缺失、字段为空以及旧版默认别名四种情况：都自动采用当前默认麦克风/扬声器，并在 UI 中正确显示。
- 系统完全没有默认麦克风或没有任何 capture endpoint：不启动无意义预热，UI 给出准确可操作提示；设备接入后能够刷新并恢复。
- 请求设备 ID 不存在：刷新/重新解析/回退策略符合设计，日志包含失败 stage。
- 默认麦克风在预热前后变化：不得激活旧端点。
- 端点在枚举后、AudioClient 初始化前消失：有限重试且无死锁、泄漏、panic。
- COM/设备初始化错误分类：`0x80070490` 不再落入无策略的 Unknown。
- 预热线程失败后 slot 被正确清理，后续预热可以再次成功。
- 预热与 cancel/activate/config change 的竞态测试。
- 冷启动 fallback 保留 STT sender，不丢失采集链路。

执行适用的单元测试、集成测试、lint/typecheck/build。不要运行全仓库格式化。若真实 Windows 设备验证可执行，则收集并展示相关日志；若受当前环境限制，明确区分“自动测试已证明”和“仍需人工硬件验证”的部分，并提供一条最短人工验证命令/步骤。

真实验证至少重复启动/预热 5 次，并覆盖一次以下操作之一：切换默认麦克风、拔插 USB/蓝牙设备、禁用后重新启用端点。验收时检查：

- 不再出现无阶段信息的 `direction=outbound ... 0x80070490`。
- 正常设备条件下 5 次均预热成功。
- 设备变化时系统能够恢复，或给出准确、可执行的错误；不能假成功。
- 点击开始后确实有音频帧流入，而非仅 `IAudioClient::Initialize` 成功。

## 每轮 Loop 输出格式

每轮简洁输出：

1. **已确认事实**：代码位置、日志或测试证据。
2. **当前根因假设**：按概率排序，并说明为何变化。
3. **本轮改动**：文件与设计意图。
4. **验证结果**：命令、通过/失败、关键输出。
5. **下一步**：只列最能缩小不确定性的动作，然后立即继续执行。

遇到测试失败时先判断是产品缺陷、测试假设错误还是环境问题；修复后重跑相关测试。不要重复相同动作却没有新增证据。

## 完成条件

只有同时满足以下条件才可结束 Loop：

- 根因已定位到具体生命周期/调用阶段，并有日志或可复现测试支撑。
- 已实施架构上合理的修复，而非隐藏警告或禁用预热。
- 新增回归测试能够在修复前失败、修复后通过，或清楚说明为何无法构造修复前对照。
- 相关测试、typecheck/lint/build 均通过；任何未通过项都有明确且与本改动无关的证据。
- 正常启动重复验证通过，设备变化/失效场景得到验证。
- `git diff --check` 通过，最终 diff 只包含本问题相关修改，未碰用户既有改动。
- 最终报告包含：根因、架构决策、修改文件、验证证据、剩余风险和复现/验收步骤。

如果必须由用户操作真实音频设备才能继续，不要笼统询问。先完成所有可自动完成的工作，再给出精确的一步操作、要观察的日志字段及成功/失败判据；收到结果后继续 Loop，直到上述条件满足。
