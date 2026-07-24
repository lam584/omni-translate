# Omni Translate「看片」按钮无响应修复 Loop 提示词

你正在维护 Windows 桌面应用 `E:\omni-translate`。请以资深 React/Tauri 架构师、Windows 音频工程师和测试负责人身份，自主执行“保护现场 → 真实复现 → 分层观测 → 根因定位 → 架构修复 → 回归验证 → 复盘”的闭环，并持续推进，直到本文的完成条件全部满足。

不要只给排查建议、代码审查意见或一份可能原因清单；你必须实际检查当前工作区、复现问题、补充可观测性、修改代码并运行验证。每一轮根据新证据调整假设，然后立即进入下一轮，直到问题真正修复。

## 当前故障

用户在应用的实时会话页面点击「看片」按钮后，界面什么也没有发生，主观体验与鼠标左键从未按下一样：

- 按钮似乎没有按下态、加载态或明确反馈；
- 没有进入可见的看片运行状态；
- 没有看到成功、失败、超时或配置阻塞提示；
- 用户无法判断点击是否到达前端、是否被前置校验拒绝、是否卡在 Tauri IPC，或后端是否已启动但状态没有返回 UI。

不要把“没有视觉反馈”直接等同于“`onClick` 没触发”。这可能是命中测试、HTML `disabled`、React 早退、异步异常、状态锁死、IPC 悬挂、后端死锁、事件丢失、启动后立即回滚，或错误提示未显示等任一层级造成。必须用同一次点击的端到端证据确定真实断点。

## 首要目标

从应用架构上修复故障，并确保：

1. 每次真实点击都能被唯一标识，并在很短时间内产生可见反馈：开始启动、明确阻塞原因或明确错误，不能静默。
2. 合法配置下，「看片」从 DOM 点击一路到达原生音频 route，并最终进入稳定运行状态；不能启动后立刻被陈旧状态、超时任务或补偿逻辑误杀。
3. 非法配置、设备不可用、模型/API 配置缺失、driver/bridge 不可用等情况必须显示准确且可操作的原因，不能表现为未点击。
4. 启动状态机只有一个权威来源；`busyAction`、`hasActiveChain`、`runningMode`、音频 snapshot 与原生 route 生命周期不能互相矛盾或永久锁死。
5. 所有异步阶段有界、可取消、可归因；任何 Promise、Tauri command、后台 task 或确认对话框都不能无限等待且无 UI 状态。
6. 修复不能依赖吞掉错误、随意增大超时、固定 sleep、去掉 `disabled`、伪造运行状态、重复触发点击或只修改按钮样式/文案。
7. 对话模式、停止全部、字幕浮窗和已有音频链路不得因修复发生回归。

## 已知代码入口（必须以当前工作区为准重新核实）

当前仓库是 React + TypeScript 前端、Tauri/Rust 桌面壳和 Windows 原生音频/bridge 架构。优先检查但不要局限于：

- `apps/desktop/src/pages/RealTimeSessionScreen.tsx`
  - 「看片」按钮当前调用 `void handleSceneLaunch('watch')`；
  - 按钮的 `disabled` 目前与 `busyAction !== null || hasActiveChain` 有关；
  - `handleSceneLaunch` 在调用 controller 前还有 readiness、配置和设备校验早退。
- `apps/desktop/src/pages/session/useSceneSessionController.ts`
  - `launchScene`、`runBusyAction`、启动事务、补偿/rollback、watch fallback；
  - `startAudioRouteRuntime('inbound', nextConfig)`；
  - `waitForWatchRouteReadyRuntime(...)`；
  - Omni preconnect、translate worker、speech dispatch、subtitle overlay 等 stage。
- `apps/desktop/src/pages/session/sceneLaunchPlan.ts`
- `apps/desktop/src/pages/session/sceneLaunchExecutor.ts`
- `apps/desktop/src/pages/session/sceneLaunchAttribution.ts`
- `apps/desktop/src/runtime/audio-runtime.ts`
- `apps/desktop/src/runtime/desktop-runtime.ts`
- `apps/desktop/src-tauri/src/api_v2.rs`
- `apps/desktop/src-tauri/src/audio/events.rs`
- `apps/desktop/src-tauri/src/audio/events/route_orchestrator.rs`
- `apps/desktop/src-tauri/src/audio/engine/**`
- bridge/driver lifecycle、runtime snapshot emit/listen 和 diagnostics 日志实现。

当前代码中可能已有关于“看片点击像没反应”“fire-and-converge”“外层 timeout 提前 rollback”的注释或未提交修复。注释不是证据，未提交改动也不代表问题已经解决。必须验证当前二进制的实际行为，并区分：

- 当前源码是否被正在运行的应用加载；
- 开发前端是否连接到了正确的 Tauri 壳；
- 当前进程是否为旧构建、另一个工作树或另一个权限级别启动的实例；
- 已有改动是用户工作成果还是本问题的一部分。

## 工作纪律与现场保护

- 开始前完整阅读根目录 `AGENTS.md`。
- 先运行 `git status --short` 和必要的只读 diff。当前工作区可能存在大量用户改动；不得还原、覆盖、暂存、提交、格式化或顺手修复无关内容。
- 若相关文件已有改动，先理解现有 diff，再做最小、兼容的精确补丁；不确定归属时保留用户实现。
- Windows 中文文件按实际编码谨慎处理。新文件使用 UTF-8；禁止 PowerShell 批量修改文件，禁止格式化命令批量改文件。代码修改使用精确补丁。
- 优先使用 `rg` 搜索，先读实现、测试和日志，再修改。
- 不要先大规模重构。先建立一次点击贯穿各层的证据，再在已证实的故障边界实施最小但架构正确的修复。
- 不要用浏览器合成 `element.click()` 代替全部验证。至少一次使用真实指针点击或等价的桌面 UI 自动化，验证 Windows/WebView 命中测试。
- 若命令需要管理员权限，先说明该权限为何是验证真实 driver/bridge 所必需，并使用项目既有的提权入口；不要偷偷绕过权限边界。

## 第一阶段：建立同一次点击的端到端证据

为一次点击生成 `launchAttemptId`（或等价 correlation id），贯穿前端、Tauri command、原生 route task、snapshot/event 和最终 UI 结果。若现有日志体系已经有 run/route id，应复用并补齐关联关系，不要平行创造多个不可关联的 ID。

至少观测以下节点及其时间：

```text
Windows pointer input
  -> WebView hit target
  -> button pointerdown/mousedown/click
  -> handleSceneLaunch('watch') entered
  -> readiness/config/device validation result
  -> launchScene entered
  -> runBusyAction acquired
  -> scene plan built
  -> every stage start/end/failure
  -> frontend runtime invoke start/resolve/reject
  -> Tauri api_v2 dispatch entered
  -> Rust start_audio_route accepted/rejected
  -> native background route task spawned
  -> capture/bridge/provider readiness or failure
  -> audio snapshot/event emitted
  -> frontend listener received snapshot
  -> UI derives running/failed/idle state
  -> runBusyAction released
```

日志必须足以区分：

- 点击没有命中按钮；
- 按钮当时为 `disabled`，以及是谁、何时、因为什么把它设为 disabled；
- handler 进入后被哪项校验早退；
- 前端 Promise 同步抛错、异步 reject 或永久 pending；
- IPC 请求未进入 Rust、进入但未响应、已确认后后台失败；
- 原生 route 已运行但 snapshot/event 未发出或前端未接收；
- UI 收到新状态但派生逻辑仍显示 idle；
- 启动成功后被另一个超时、effect cleanup、stop 或 rollback 任务停止。

日志中不得记录 API Key、token、完整敏感配置或用户音频内容。临时诊断日志若无长期价值，问题定位后应移除；有长期价值的结构化阶段日志应保留并测试。

## 必查架构层级

### 1. Windows、Tauri 窗口与 WebView 命中测试

逐项检查并用 DevTools/桌面自动化或截图证实：

- 点击坐标下实际命中的 DOM 元素，`event.target/currentTarget` 是否为按钮；
- 是否有透明元素、弹窗 backdrop、loading mask、拖拽区域、字幕层、伪元素或不可见容器覆盖按钮；
- `z-index`、`position`、`pointer-events`、`opacity`、`visibility`、`display`、transform 和 stacking context；
- Tauri 的窗口拖拽区域、透明窗口、always-on-top 子窗口是否截获输入；
- 按钮是否因 HTML `disabled` 根本不发出 click；不能仅查看视觉颜色；
- 鼠标、触控板、键盘 `Enter/Space` 激活行为是否一致；窗口失焦/重新聚焦是否改变结果；
- DPI 缩放、窗口尺寸和 responsive CSS 是否导致一个不可见层错位覆盖。

如果真实 pointer 事件未到达按钮，先修命中测试与布局根因，再继续验证完整启动链路；不要通过全局 `pointer-events: none` 粗暴绕过。

### 2. React 事件、前置校验和反馈渲染

检查：

- `handleSceneLaunch` 的每个 return 分支是否都设置了用户实际可见的问题信息；
- `sessionLaunchProblem`、notification、confirm/fallback 是否真的渲染在当前视口，是否被清空、遮挡或写入了另一个 store/window；
- `void handleSceneLaunch(...)` 是否让 handler 外层异常变成 unhandled rejection，导致既无 notification 也无错误边界反馈；
- readiness 和设备校验是否使用陈旧闭包、旧 config snapshot 或尚未恢复完成的数据；
- i18n/渲染异常是否在点击后中断组件更新；
- React StrictMode、组件卸载重挂、route navigation 和 effect cleanup 是否取消或覆盖当前 attempt；
- 点击后的同步 UI 反馈是否依赖一个很晚才返回的原生 snapshot。启动态应在前端接受点击并通过同步校验后立刻出现。

不要简单在最外层加一个 `catch {}`。错误必须进入统一的 attempt 终态，并生成可见、可操作的反馈。

### 3. 启动状态机与并发互斥

重点核对 `busyAction`、`hasActiveChain`、`runningMode`、`isSessionRunning`、inbound/outbound `captureState`、worker 状态和 overlay 状态的定义：

- `hasActiveChain` 是否把预热、stale route、stopping、error、仅 overlay 或残留 worker 误算为活动链路，从而永久禁用按钮；
- `busyAction` 是否在异常、确认对话框、组件卸载或竞态中未被 `finally` 清除；
- 是否存在双重 `runBusyAction`、不可重入锁或 closure 捕获旧值；
- `stopping` 分支是否静默 return；用户是否获得反馈且停止完成后按钮自动恢复；
- 上次失败的 route/task/snapshot 是否残留为假 running 或假 busy；
- 快速双击、启动中点击停止、失败后重试、从对话模式切换等操作是否满足明确状态转移；
- 是否有两个状态源分别认为自己有权设置 idle/running，造成“后写入的旧 snapshot 覆盖新 attempt”。

优先形成显式的场景启动状态机，例如：

```text
idle
  -> validating
  -> launching(stage)
  -> accepted/converging
  -> running
  -> stopping
  -> idle

validating/launching/converging
  -> blocked | failed | cancelled
  -> idle（保留最后一次可见结果）
```

具体命名可按仓库风格调整，但必须规定每个状态的进入者、退出条件、超时/取消、UI 表现和日志字段。不要让一个布尔值同时代表“命令已接受”“音频已绑定”和“完整翻译链已就绪”。

### 4. Scene launch 事务、超时与补偿

完整追踪 `buildSceneLaunchPlan` 和 `executeSceneLaunchPlan`：

- 实际 stage 顺序是否符合 watch 模式的依赖；并行 Omni preconnect 是否会阻塞主链；
- stage callback 是否可能从未 resolve/reject；
- timeout 是观察性超时还是破坏性超时，是否在 native route 即将 ready 时执行 stop/rollback；
- 已超时或已取消 attempt 的晚到结果是否仍能改写当前 attempt 状态；
- compensation 是否只撤销本 attempt 创建的资源，还是误停了预热资源、之前健康 route 或之后的新 attempt；
- `routeCommandAccepted` 是否准确代表 Tauri command ack，而不是误把某个 snapshot 当成 ack；
- fallback 确认框是否在主窗口背后、没有 owner、等待用户输入却让按钮看似无响应；
- catch 分支是否报告错误后又被外层状态更新清空；
- 现有关于 watch `fire-and-converge` 和移除外层 destructive timeout 的实现是否真的消除了竞态，还是产生了无上限等待。

若采用 fire-and-converge，仍必须有：立即的 accepted/converging UI、后台阶段 watchdog、结构化失败事件、用户可取消路径，以及晚到事件的 attempt/route id 隔离。不能把“取消破坏性超时”变成“永远 pending”。

### 5. TypeScript runtime 与 Tauri IPC

检查 `desktopApiV2.runtime.invoke` 及其封装：

- invoke 的 command 名、payload schema、方向和 config 是否正确；
- command handler 是否注册在当前 Tauri build 中；
- invoke 是否因 web-only/dev mock、旧壳版本或 API v1/v2 路由不一致而没有到后端；
- timeout/cancellation 包装是否正确释放 listener 和 busy 状态；
- 同一 command 的重复请求如何去重；旧请求是否会阻塞新请求；
- Rust panic、task panic、channel close、序列化失败是否一定转换成前端可见 reject；
- 前端 audio snapshot listener 是否只注册一次、是否过早取消、是否能回放订阅前已经发出的最新 snapshot；
- 事件乱序时是否按 revision/attempt id 拒绝陈旧 snapshot。

必须验证正在运行的壳确实包含当前 command 和当前源码版本，必要时输出非敏感 build/version marker。

### 6. Rust route orchestrator、锁与后台任务

从 `api_v2.rs` 进入 `audio/events/route_orchestrator.rs` 和 `audio/engine/**`，检查：

- async command 是否持有 mutex/RwLock 跨越 `.await`、阻塞 I/O、线程 join 或 event emit；
- `spawn_blocking`、thread、channel sender/receiver 是否存在永不返回、无人接收或容量耗尽；
- command 的“已接受”边界是否明确，后台 task 的 panic/error 是否能更新 snapshot 并 emit；
- route registry 是否有 stale entry，让启动逻辑误以为 route 已存在后直接返回旧 snapshot；
- 预热 route 的 activate/cancel 与正式 watch route 是否竞态；
- bridge/driver readiness 是否在不需要 bridge 的配置下仍成为硬依赖；
- provider websocket、设备初始化、WASAPI、bridge pipe 的每一阶段是否有合理 timeout 和取消；
- stop/rollback 是否通过 route/attempt generation 隔离，避免旧 watchdog 停止新 route；
- 后端已失败时 `lastError`、capture state 和 diagnostics marker 是否原子一致；
- event emit 失败是否被无条件忽略，从而前端永远停留在启动中。

不要为了让 command 快速返回而伪造 ready。可将“command accepted”和“route ready”拆开，但两者都必须有可验证的协议语义。

## 根因假设清单（逐项证伪或确认）

至少调查以下假设，并在工作记录中给出支持/反证证据：

1. 按钮被透明层、拖拽区或 responsive CSS 覆盖，真实 pointer 事件没有命中。
2. `busyAction` 或 `hasActiveChain` 因上一次残留状态使原生 `disabled=true`，用户看到的样式却不像禁用。
3. `handleSceneLaunch` 的 readiness/config/device 分支早退，但问题信息没有显示或马上被清空。
4. `void` 丢弃的 async handler 在进入 `launchScene` 前抛错，形成未处理 rejection。
5. `runBusyAction` 没有可靠 `finally`，导致启动锁永久占用，或双重互斥使内部 action 根本不执行。
6. 正在运行的桌面壳/前端不是当前源码构建，或 dev server 与旧的 elevated Tauri 进程错配。
7. `start_audio_route` invoke 未注册、payload 不匹配、IPC 卡住或 Rust command panic，前端没有得到 settle。
8. 后端接受 command 后后台 route 失败，但 snapshot emit/listener 链断裂。
9. 启动事务的 timeout/abort/compensation 在 route 即将 ready 时停止它，最终错误又被吞掉。
10. 移除破坏性 timeout 后，某个 stage 无上限 pending，使 busy 状态和按钮文案无法收敛。
11. 旧 attempt 的 watchdog、stop 或晚到 snapshot 覆盖了新 attempt 的状态。
12. fallback/confirm 对话框实际在等待输入，但窗口隐藏在主窗口后或未正确聚焦。
13. 预热、bridge、driver、WASAPI 或 provider 初始化持锁/等待循环，从架构上阻塞了启动 ack。
14. watch route 已成功运行，但 `runningMode`/`hasActiveChain` 派生条件错误，UI仍呈现未启动。

可增加假设，但不能只凭概率最高的一项直接修改。先用最低成本、最高区分度的观测缩小范围。

## 修复原则

- 建立一个明确的 `launchAttempt` 生命周期，贯穿 UI、事务和原生 route；避免靠若干无关联布尔状态拼凑真相。
- 接受点击后立即显示 `validating/launching`；校验失败进入 `blocked` 并显示原因；IPC accepted 后进入 `converging`；只有真实 readiness 证据才能进入 `running`。
- 每个早退、异常、取消和超时都必须 settle 当前 attempt，并释放互斥锁。
- 所有后台结果必须携带或能够映射到 route/attempt generation；陈旧结果不得覆盖当前状态。
- destructive rollback 只能操作当前事务实际创建的资源，并且必须幂等。
- 原生 command ack、route ready、音频帧流入、provider ready、字幕/译音 ready 是不同里程碑；日志和 UI按产品需要分别表达。
- 保留 watch 模式在用户播放媒体前即可启动的产品语义。不能要求先检测到响亮音频帧才把 capture route 视为启动成功；但后续无帧/设备失败必须由 flow-health watchdog 可观测归因。
- 错误反馈要具体到阶段和下一步，但不要把底层堆栈原样抛给普通用户。完整上下文写入诊断日志。
- 若根因只在 CSS/命中层，也仍需确保前端 handler 和后端失败均不会静默；同类“像没点击”的体验应有系统性防线。

## 测试与验证要求

先找到现有测试入口并补最小充分的回归测试。至少覆盖：

### 前端组件/状态机

- 合法 idle 状态下真实用户级 click 调用一次 `handleSceneLaunch('watch')`，立即出现启动反馈。
- HTML disabled 的每个原因都有可见解释或明确状态，不允许“看起来可点但实际 disabled”。
- 每个 readiness/config/device 早退分支都显示对应问题。
- handler 在 controller 调用前抛错、controller reject、IPC reject、超时、取消时均进入 failed/blocked 并释放 busy。
- `runBusyAction` 在 success/reject/throw/cancel/unmount 路径不会残留锁。
- 快速双击只产生一个有效 attempt；失败后可以再次点击成功。
- 旧 attempt 的晚到 success/error/snapshot 不覆盖新 attempt。
- watch 启动成功后 UI 显示 running；停止后恢复 idle；对话模式无回归。
- fallback 确认可见、可操作、可取消，不会形成隐形 pending。

### TypeScript runtime/事务

- `start_audio_route` invoke resolve/reject/永久 pending（用受控 fake timer）三类行为均有确定终态。
- command accepted 但 route 较晚 ready 时，不被旧 outer timeout 错误 rollback。
- command accepted 后后台失败时，错误 snapshot/event 能归因到当前 attempt。
- scene executor 的 stage 顺序、补偿范围和 cancellation 正确。
- listener 晚订阅能获得最新 snapshot，事件乱序不会回退状态。

### Rust/Tauri

- command dispatch 进入、快速 ack 与后台 task 生命周期的契约测试。
- 后台 task 返回 Err 或 panic 时，capture state/lastError/snapshot emit 均收敛。
- stale route、重复 start、start/stop 竞态、旧 watchdog 与新 route 并发。
- mutex/channel/task 不在失败路径泄漏或永久阻塞。
- bridge/driver/provider/WASAPI 各关键失败能映射为结构化阶段错误。

### 真实桌面验证

至少完成：

1. 从干净启动状态使用真实指针点击「看片」，保存点击前、启动中、运行中截图和同一 attempt 的日志。
2. 重复“启动 → 停止”至少 5 次，每次按钮都立即反馈且最终状态正确。
3. 在媒体尚未播放时先点击看片，route 仍能进入合理的 accepted/ready 状态；随后播放媒体能观察到输入帧/能量或等价证据。
4. 制造一种明确失败：例如暂时选择不可用设备、停止 bridge 或使用无效模型配置，确认 UI快速显示准确原因且可重试。
5. 至少验证一次快速双击、启动中停止或失败后重试。
6. 若项目已有 watch live runner，按文档运行适用的 dry-run、report test 和真实 live diagnostic；不能把历史 artifact 当作当前通过证据。

优先执行与改动相关的单元测试，然后运行适用的 typecheck、lint、Rust tests、build 和架构检查。不要运行全仓库格式化。运行 `git diff --check`，确认最终 diff 没有无关改动或编码破坏。

真实硬件链路若受环境限制，必须清楚区分：自动测试已证明什么、当前机器真实桌面已证明什么、仍需要用户完成什么。只有必须由用户操作时才暂停，而且应只要求一个精确动作，同时给出要观察的 `launchAttemptId`、日志字段和成功/失败判据；拿到结果后继续 Loop。

## 推荐验证命令（先核对当前 package scripts）

根据实际改动选择执行，不要机械地一次运行所有重型任务：

```text
npm run check:desktop
npm run lint:desktop
npm run build:desktop
npm run check:desktop-shell
npm run test:desktop-shell
npm run test:watch-mode-report
npm run test:watch-mode-live:dry-run
npm run audit:architecture
git diff --check
```

同时运行直接覆盖 `RealTimeSessionPage`、`audio-runtime`、scene launch plan/executor/attribution 和 Rust route orchestrator 的最小测试。真实 live diagnostic 应使用项目文档给出的当前命令和当前 artifact 路径，不使用仓库根目录的旧报告替代。

## 每轮 Loop 输出格式

每轮只输出能推动问题收敛的信息，然后立即继续执行：

1. **已确认事实**：本轮新增的代码、DOM、日志、状态或测试证据，附文件/阶段/attempt id。
2. **当前断点**：同一次点击最后一个确认到达的节点，以及下一个未到达节点。
3. **根因假设排序**：说明哪些假设被证伪、哪些概率上升以及原因。
4. **本轮改动**：文件、设计意图、为何解决已证实的机制而不是掩盖症状。
5. **验证结果**：命令、通过/失败、关键输出和真实 UI 观察。
6. **下一步**：只列最能缩小剩余不确定性的动作，然后立即执行。

遇到失败时先分类为产品缺陷、测试假设错误、构建/进程错配、权限问题或外部环境问题。除非有新证据，不要重复相同命令或相同点击。

## 完成条件

只有以下条件全部满足才可结束 Loop：

- 已将根因定位到具体层级、状态转移、调用阶段或竞态，并有同一次点击的日志、测试或真实 UI 证据支撑。
- 已实施架构上合理的修复；不是仅改样式、文案、超时数值或吞掉错误。
- 从真实 pointer 点击到 React handler、Tauri command、原生 route 和 UI 终态的证据链完整。
- 任一结果都会在短时间内产生可见反馈：launching、running、blocked、failed 或 cancelled，不存在静默 pending。
- 新增回归测试能在修复前暴露故障、修复后通过；若不能构造修复前对照，必须说明限制并提供替代证据。
- 相关 TypeScript/Rust 测试、typecheck、lint/build 均通过；任何未通过项都有明确且与本改动无关的证据。
- 真实桌面“启动 → 停止”连续 5 次通过，并覆盖媒体未播放时先启动、至少一种失败路径及失败后重试。
- 对话模式、停止全部、字幕浮窗和现有 watch live/report 测试没有回归。
- `git diff --check` 通过，最终 diff 只包含本问题相关修改，未覆盖用户既有改动，未破坏中文编码。
- 最终报告包含：根因、证据链、架构决策、修改文件、测试与真实验证结果、剩余风险、复现及验收步骤。

如果发现当前工作区其实已经包含了候选修复，也不能仅凭代码阅读结束。先构建并确保运行的是当前源码，再按上述真实点击和重复验证标准证明修复有效；若仍失败，继续 Loop 追踪下一个断点，直到所有完成条件满足。
