# Watch Mode 真实链路自动化测试

本文档记录看片模式的真实链路自动化测试方式，用于以后快速复现问题并让 agent 直接读取结构化报告定位失败层级。

## 测试目标

这条测试链路要覆盖真实用户场景：

1. 系统/媒体音频播放到 Omni 虚拟扬声器。
2. 虚拟音频驱动产生可捕获的 WASAPI loopback 信号。
3. native bridge 能订阅 source frame。
4. desktop watch mode 能启动 route，并按当前音频路由配置选择 native 或 secondary 路线。
5. native 路线不额外启动二次分句文本翻译/二次字幕 TTS；secondary 路线才逐句调用文本翻译和二次字幕译音。
6. bridge 的物理播放路径能把原声实时写到指定物理播放设备，译音启用时与原声混合输出。
7. WASAPI loopback 能在物理播放设备上捕获到实际输出电平，并验证原声/译音内容证据。
8. 默认播放完整 `scripts/testing/fixtures/watch-mode-en-original.wav`，播放结束后继续观察 120 秒再停止 watch mode 和 bridge，用来捕捉短音频触发长时间复述、循环输出、漏句和多句。
9. 使用真实 STT 对源音频生成基准转录并缓存；再对物理输出录音做 STT，把两份文本做内容一致性检查。
10. 对原创 WAV 素材增加 `strictContent` 层，用固定中文参考译文做确定性评分，拦截只覆盖开头、漏掉关键短语或把 `十亿美元` 误成 `一亿美元` 等严重数字错误。
11. 发布前严格证据门槛必须同时覆盖 `qwen3.5-omni-flash-realtime` 和 `qwen3.5-livetranslate-flash-realtime` 两个模型；任意一个缺失或失败都不能通过。

## 核心命令

普通 dry-run，不需要管理员权限：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "& { . .\scripts\testing\run-watch-mode-live.ps1 -DryRun -Fixture pass }"
```

单模型真实 live run 建议在管理员 PowerShell 中运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\testing\run-watch-mode-live.ps1 -SkipDriverRepair -AllowElevatedDesktopLaunch -WatchModelId qwen3.5-omni-flash-realtime -PlaybackSeconds 0 -PostPlaybackWaitSeconds 120 -SessionReadyTimeoutSeconds 90 -MediaPath .\scripts\testing\fixtures\watch-mode-en-original.wav
```

双模型 × 三路线 × 两个真实物理设备严格矩阵：

```powershell
node .\scripts\testing\run-watch-mode-live-matrix.mjs --device-profiles .\artifacts\testing\watch-mode-device-profiles.json --skip-driver-repair --allow-elevated-desktop-launch
```

PowerShell 下使用 npm 11 转发参数时需要两层 `--`：`npm run test:watch-mode-live:matrix -- -- --device-profiles ...`。上面直接执行 Node 入口可避免 npm 版本对参数转发语义的差异。

严格入口必须显式传入 `--device-profiles`，JSON 中必须恰好各有一个 `default-speaker` 与独立 `usb` profile；USB 必须写明真实 MMDevice id 和预期端点名称。Bluetooth 是可选诊断端点，不能用 USB 端点伪装。缺失 profile 时矩阵直接失败，绝不退化成默认扬声器单设备。matrix 默认对每个模型跑 `process-exclusion`、`virtual-driver` 和 `echo-cancel` 三个 `feedbackLoopPrevention` 变体，并把本次 14 个 run directory 写入唯一 manifest；verifier 只读取该 manifest，不扫描 output root 中的历史报告。支持 Windows build 20348 及以上时，`process-exclusion` 是推荐路线；能力探测失败时该变体必须明确失败或跳过为不支持，不能静默改跑其他后端。单设备调试请直接运行 `run-watch-mode-live.ps1`，或显式使用 `--diagnostic-single-device`；其结果属于 non-strict，不能发布 release manifest。单独跑 process-exclusion 变体：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\testing\run-watch-mode-live.ps1 -SkipDriverRepair -AllowElevatedDesktopLaunch -WatchModelId qwen3.5-omni-flash-realtime -FeedbackLoopPrevention process-exclusion -PlaybackSeconds 0 -PostPlaybackWaitSeconds 120 -SessionReadyTimeoutSeconds 90 -MediaPath .\scripts\testing\fixtures\watch-mode-en-original.wav
```

单独跑 echo-cancel 变体：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\testing\run-watch-mode-live.ps1 -SkipDriverRepair -AllowElevatedDesktopLaunch -WatchModelId qwen3.5-omni-flash-realtime -FeedbackLoopPrevention echo-cancel -PlaybackSeconds 0 -PostPlaybackWaitSeconds 120 -SessionReadyTimeoutSeconds 90 -MediaPath .\scripts\testing\fixtures\watch-mode-en-original.wav
```

严格 evidence verifier：

```powershell
npm run test:watch-mode-evidence:strict
```

该命令固定读取 `artifacts/testing/watch-mode-live/latest-successful-watch-mode-strict-matrix.json`。发布验证采用预算平衡方案：6 个零 LLM 本地隔离格（3 路线 × 2 个真实物理设备类，每格 5 分钟）、6 个 live 配对格（每格 4 分钟）和 2 个模型稳定格（每格 7 分钟）。只有这 14 个格子的固定 authority 全部通过，本次 scoped verifier 才会原子替换 canonical manifest；失败、中断、single-device diagnostic 和 `-DryRun` 都不能覆盖它。matrix 明确拒绝 `-DryRun`，脚本 fixture 自测只能使用 `npm run test:watch-mode-live:dry-run`，其报告保持 `mode=dry-run`，不会进入 strict 验收。

付费 live 层固定为 38 LLM 分钟，而不是原来的 18 × 30 分钟：

- `pairwise-live`：6 个模型/路线/设备配对格 × 4 分钟，共 24 分钟；保证每个模型、每条路线和每类设备在组合层都出现，并为实时翻译的尾段物理播放预留排空时间。
- `model-stability`：2 个模型 × 7 分钟，共 14 分钟；固定使用 `process-exclusion/default-speaker`。
- `local-isolation`：6 个格 × 5 分钟，Provider 完全禁用，`providerCalls=0`，不消耗 LLM token。

矩阵在构建完成后、任何本地格或付费格开始前，会先对 `provider-dashscope` 执行 production provider preflight；若凭据、entitlement、streaming 或翻译文本不可用，整次运行立即 fail-closed，避免产生长时设备占用或付费调用。

Strict matrix 启动前要求 Git 工作树完全 clean（包括未跟踪源码），并固定当时的精确 `HEAD`。每份 `report.json`、本次 matrix manifest 和 canonical manifest 都记录 `provenance`（`headCommit`、`worktreeClean`、`dirtyEntryCount`）；matrix 结束、scoped verifier 和 canonical 发布会再次读取当前 checkout。只有生成时与验证时均 clean 且 `headCommit` 与当前 `HEAD` 完全相等才通过；旧 ancestor commit 即使可达也不能作为当前发布证据。运行期间提交、修改或新增未跟踪源码会使整次 strict matrix 失效，必须在 clean checkout 上重跑。

重要约束：

- 默认不要安装、卸载、修复驱动；真实验证命令必须带 `-SkipDriverRepair`。
- 只有明确需要验证驱动安装/修复时，才使用 elevated driver operation。
- 如果当前 shell 不是管理员，runner 会拒绝启动可能自提权的 desktop shell，避免产生自己停不掉的残留进程。
- 如果 run 被中断，先检查并清理 `omni-desktop-shell.exe` 和 `omni-bridge-service.exe`。

## 产物位置

每次运行会写入：

```text
artifacts/testing/watch-mode-live/<timestamp>/
```

关键文件：

- `report.json`: agent 优先读取的机器可读报告；包含生成时的精确 Git `provenance`。
- `report.md`: 人类可读摘要。
- `../watch-mode-live-matrix-*.json`: 单次 matrix 的精确 run directory 清单和 source provenance。
- `../latest-successful-watch-mode-strict-matrix.json`: 最近一次成功完成 scoped strict 验证、并与当前 clean `HEAD` 精确绑定的预算平衡 canonical manifest（6 个零 LLM 本地格 + 8 个付费 live 格）。
- `../latest-watch-mode-live.json`: 最新 live run 的轻量索引，只包含 `timestamp`、`reportPath`、`verdict`、`failureLayer`、`modelId`。
- `snapshots.json`: driver、wasapi、bridge、physicalOutput、app、provider、playback 快照。
- `steps.json`: 每个编排步骤的执行结果。
- `app.log`: 本次复制出的应用日志。
- `bridge-service.log`: 本次复制出的 bridge 日志。
- `driver.json`: driver/WASAPI probe 结果。
- `bridge-source-probe.json`: bridge source frame probe 结果。
- `physical-output-probe.json`: 物理播放设备输出电平 probe 结果。
- `source-media-transcript.json`: 对原创 WAV 素材的真实 STT 基准转录，按媒体 SHA256 和播放秒数缓存。
- `physical-output-content.json`: 对物理输出录音的真实 STT 和与源音频基准的内容一致性比较。

后续修 bug 时，优先读取：

```powershell
Get-Content artifacts\testing\watch-mode-live\latest-watch-mode-live.json -Raw
Get-Content artifacts\testing\watch-mode-live\<timestamp>\report.json -Raw
Get-Content artifacts\testing\watch-mode-live\<timestamp>\steps.json -Raw
Get-Content artifacts\testing\watch-mode-live\<timestamp>\physical-output-probe.json -Raw
Get-Content artifacts\testing\watch-mode-live\<timestamp>\physical-output-content.json -Raw
```

不要把仓库根目录下的 `report.json` 或 `report.md` 当作当前项目状态来源。普通本地诊断用 `npm run test:watch-mode-evidence` 扫描 `artifacts/testing/watch-mode-live/<timestamp>/report.json`；发布前严格证据只认 canonical manifest 绑定的本次 6 个本地 authority 格和 8 个 live 目录，禁止从 output root 自动挑选历史报告补格。

## 分层判定

`report.json` 的 `layers` 至少包含：

- `driver`: ROOT 设备、音频端点、ABI、ring buffer、captured/delivered/dropped bytes。
- `wasapi`: 虚拟扬声器 loopback 的 idle/tone RMS、peak、invalid samples、silent packets。
- `bridge`: bridge lifecycle、driverHealth、source subscriber、source frame、队列、掉帧、watchdog。
- `physicalOutput`: bridge 写到物理播放设备后的实际输出电平。
- `physicalOutputContent`: 源音频基准转录、物理输出录音转录、内容覆盖率、长度比例、漏句和多句。
- `speechSegmentation`: secondary 路线下的最终句段数量、最大句段长度和句段译音播放证据。
- `strictContent`: 原创 WAV 素材的完整中文参考译文覆盖、关键概念、严重数字错误、最终字幕写入数、译音排队数和译音播放数。
- `app`: watch route、overlay、subtitle cue、speech dispatch 证据。
- `provider`: 真实 provider/model 请求、失败、认证、限流、网络错误证据。

`report.json` 还会包含 `translationRoute`：

- `native`: 主听译/Omni 模型直接输出翻译字幕/译音，不要求 `speech.segment_*` 证据。
- `secondary`: 只有音频路由页二次翻译卡片启用时使用；必须存在最终句段分句和二次字幕译音证据。

通过条件是 `verdict=passed`，并且各层状态均为 `passed`。对完整原创 WAV 素材，`strictContent` 还必须满足：

- 覆盖核心概念：`十亿美元`、`火星`、`五亿美元`、`人工生物圈`、`濒危物种`、`飞行汽车`、`一美元的灯泡`。
- 禁止严重数字错误，例如把 `十亿美元` 输出成 `一亿美元`。
- `finalWriteCount >= 8`、`queuedSegmentCount >= 8`、`playedSegmentCount >= 8`。
- `physicalOutputContent.contentConsistency.combinedEvidence.passed=false` 时不能通过内容层。

独立证据门禁：

```powershell
npm run test:watch-mode-evidence
npm run test:watch-mode-evidence:strict
```

普通 `npm run test:watch-mode-evidence` 会扫描 `artifacts/testing/watch-mode-live/*/report.json`，并跳过 `cache`、`physical-output-smoke-*`、`reference-pcm-smoke-*` 等非完整 live 目录。严格命令不执行这种扫描，只读取 canonical manifest 精确绑定的 8 份 live report 和 9 格本地隔离 authority，并按 `cellId/tier` 分别校验 4 分钟配对时长、7 分钟稳定时长、5 分钟零 Provider 本地时长、设备身份、唯一 session、report/manifest provenance 与当前 clean `HEAD` 精确相等，以及 `strictContent.passed=true`。ancestor commit、生成时 dirty、验证时 dirty 或未跟踪源码都会失败。普通 `npm run quality:gate` 不会启动真实硬件链路；`release:verify` 会额外执行严格 evidence 门禁。

失败时重点看：

- `failureLayer`: 首个失败层。
- `failureReason`: 直接原因。
- `suspectFiles`: 优先检查文件。
- `layers.<layer>.data`: 对应层的原始指标。

## 物理输出验证

为了覆盖“用户到底有没有听到声音”，live runner 会额外运行物理输出 probe 和内容录制：

```text
target/release/omni-physical-output-probe.exe
```

该 probe 做的事：

1. 启动独立 bridge service。
2. 使用 `physicalPlaybackDeviceId=耳机 (iBasso-DC-Series)` 初始化 bridge。
3. 通过 bridge 的 `-audio` 管道发送一段 1 kHz PCM16LE translation frame。
4. bridge 使用真实 monitor playback 路径写到物理播放设备。
5. probe 用 WASAPI loopback 捕获物理播放设备输出。
6. 输出 `rms`、`peak`、`toneFrequencyHz`、`toneComponent`、`capturedFrames`。

watch/game 场景的通过条件不是“只听到译音”。在 `耳机 (iBasso-DC-Series)` 上必须能捕获到：

- `originalPassthrough`: 虚拟扬声器输入的原声实时旁路到物理设备。
- `translatedSpeech`: secondary 二次字幕译音启用时，最终句段 TTS 也写入物理设备。
- `mixedOutput`: 原声不能被完全静音；译音播放时允许 ducking，但不能替代原声。
- `contentConsistency`: 物理输出录音转录与源音频基准转录内容一致，不能明显漏句、额外输出无关句子或把完整测试音频复述成远超原文长度。

native 路线只验证原声旁路和原生模型能力对应的输出；secondary 路线额外验证 `speech.segment_tts_queued`、`speech.segment_tts_requested`、`speech.segment_playback_written`。

## 内容一致性验证

live runner 会先对 `scripts/testing/fixtures/watch-mode-en-original.wav` 的实际播放窗口调用真实 STT。默认 `-PlaybackSeconds 0` 表示完整播放整段素材；只有显式传入正数时才限制播放窗口，并把该秒数写进 source reference：

```text
scripts/diagnostics/omni-benchmark/target/debug/omni-benchmark.exe --audio scripts/testing/fixtures/watch-mode-en-original.wav --manual --json
```

基准转录会写入本次产物的 `source-media-transcript.json`，并缓存到：

```text
artifacts/testing/watch-mode-live/cache/source-transcripts/<media-sha256>-full-v2.json
```

随后 runner 会在播放测试音频前启动物理输出录音，完整播放后继续等待 120 秒，再停止录音并把录音提交给同一个 STT 诊断程序。`physical-output-content.json` 会包含：

- `sourceReference`: 源音频基准转录。
- `source` / `translation`: 物理输出录音转录结果。
- `contentConsistency.coverage`: 源音频 clause 被物理输出覆盖的比例。
- `contentConsistency.lengthRatio`: 物理输出转录长度与源音频基准长度的比例。
- `contentConsistency.missingClauses`: 源音频中没有被输出覆盖的句段。
- `contentConsistency.extraClauses`: 物理输出中与源音频不匹配的额外句段。

第一版使用确定性文本比较作为自动失败门槛，允许少量 STT 表述差异，但会关注：

- 源音频句段覆盖率低于阈值。
- 漏句超过 1 个。
- 多出无关句段超过 2 个。
- 输出长度超过源音频基准约 2.2 倍。

这类失败归因到 `physicalOutputContent`，典型 `failureReason` 为：

```text
physical output content diverged from source media reference; coverage=... lengthRatio=... missingClauses=... extraClauses=...
```

这个门槛专门覆盖“用户播放 11 秒音频，但应用复述 3 分钟仍没结束”的问题：即使物理输出有电平、字幕有内容、provider 没报错，只要录音转录相对源音频出现明显额外复述，报告也必须失败。

该层失败示例：

- `physical playback device was not resolved`: 物理播放设备未解析。
- `bridge did not write frames to the physical playback device`: bridge 没有写出帧。
- `physical playback loopback captured no frames`: 物理设备 loopback 没有帧。
- `physical playback loopback is silent`: 抓到了帧但全静音。
- `physical playback loopback did not capture the probe tone`: 有电平但不是预期 probe tone。

## 已验证样例

以下目录是历史样例，只能说明当时某个链路行为曾经通过，不代表当前工作区自动通过。普通诊断以本机最新完整 live report 和 `npm run test:watch-mode-evidence` 为准；发布结论只认 canonical strict manifest 及 `npm run test:watch-mode-evidence:strict`。

历史完整管理员 live run：

```text
artifacts/testing/watch-mode-live/20260604-222958/
```

结果摘要：

```json
{
  "verdict": "passed",
  "layers": {
    "driver": "passed",
    "wasapi": "passed",
    "bridge": "passed",
    "physicalOutput": "passed",
    "app": "passed",
    "provider": "passed"
  },
  "playback": {
    "playbackMode": "mci-default-endpoint",
    "playedSeconds": 30,
    "naturalDurationSeconds": 30.053,
    "defaultEndpointSwitched": true
  },
  "physicalOutput": {
    "physicalPlaybackDeviceId": "default",
    "resolvedPhysicalPlaybackDeviceName": "iBasso-DC-Series",
    "playbackFramesWrittenAfter": 96000,
    "capturedFrames": 125856,
    "peak": 0.79612714,
    "rms": 0.17022072,
    "toneFrequencyHz": 1000,
    "toneComponent": 0.09170815,
    "silentPackets": 0,
    "invalidSamples": 0
  }
}
```

这证明了：

- 测试媒体实际播放了 30 秒。
- 虚拟扬声器和 WASAPI probe 有信号。
- bridge 能读到 source frame。
- watch app/provider/subtitle 证据存在。
- bridge 物理播放路径能写到默认物理设备。
- 默认物理设备上能捕获到非静音 1 kHz 输出电平。
- 运行结束后没有 `omni-desktop-shell.exe` / `omni-bridge-service.exe` 残留。

## Native 与 Secondary 路线

音频路由页“二次翻译”卡片决定是否启用智能分句：

- 两个卡片都关闭时，`devices.subtitleTranslationMode=native`。此时不启动 `subtitle_translate` worker，不按句调用文本 LLM/TTS。
- “启用字幕翻译”打开时，`devices.subtitleTranslationMode=secondary` 且需要 `devices.subtitleTranslationModelId`；此时源文本会被智能分句并逐句翻译为字幕。
- “用二次字幕生成译音”打开时，还需要 `devices.outputSpeechEnabled=true`；此时只播放 `pending=false` 的最终句段，不播放 forced/pending 临时片段。
- 二次字幕译音关闭时，即使有二次字幕，也不额外合成句段译音。

当前不把“驱动内核直通到物理耳机”作为 live 通过条件。该方向只能做离线实验、构建和代码审查；不要在自动化中安装、卸载或重装驱动。

## 常用辅助验证

报告逻辑单元测试：

```powershell
node --test .\scripts\testing\watch-mode-report.test.mjs
```

bridge native 编译：

```powershell
cargo build --release --manifest-path apps/bridge-service-native/Cargo.toml
```

单独验证物理输出 probe：

```powershell
$out = "artifacts/testing/watch-mode-live/physical-output-smoke-" + (Get-Date -Format "yyyyMMdd-HHmmss")
New-Item -ItemType Directory -Force -Path $out | Out-Null
.\apps\bridge-service-native\target\release\omni-physical-output-probe.exe `
  --bridge-exe .\apps\bridge-service-native\target\release\omni-bridge-service.exe `
  --runtime-root "$out\runtime" `
  --physical-playback-device-id "耳机 (iBasso-DC-Series)" `
  --physical-playback-level 50 |
  Tee-Object -FilePath (Join-Path $out "physical-output-probe.json")
```

检查残留进程：

```powershell
Get-Process omni-desktop-shell,omni-bridge-service -ErrorAction SilentlyContinue |
  Select-Object ProcessName,Id,Path
```

管理员清理残留进程：

```powershell
Get-Process omni-desktop-shell,omni-bridge-service -ErrorAction SilentlyContinue |
  Stop-Process -Force
```

## 注意事项

- 物理输出 probe 会短暂播放 1 kHz tone 到默认物理设备，运行前注意音量。
- 如果默认物理设备是蓝牙/USB DAC，设备切换或休眠可能影响第一次捕获；失败时先看 `physical-output-probe.json` 的 `resolvedPhysicalPlaybackDeviceName`。
- 如果用户在 UI 中选择了非默认物理设备，后续应把 runner 扩展为读取当前 app config 的 `devices.outputDeviceId`，并传给 `--physical-playback-device-id`。
- 真实 provider/API 失败应归因到 `provider`，不要和 driver/bridge/physicalOutput 混在一起。
- 覆盖率不能替代这条真实链路；覆盖率只保护纯逻辑，不能证明驱动、WASAPI、bridge、物理输出和真实 API 的组合行为。

## 2026-08-10 三路线与反馈隔离约束

- 三个变体是三个独立采集后端：`process-exclusion` 使用 WASAPI application loopback 并排除 Bridge 进程树；`virtual-driver` 使用虚拟扬声器/虚拟麦克风链；`echo-cancel` 使用物理端点 loopback 加 WebRTC AEC3。任何变体失败都不得静默切换到另一变体。
- process-exclusion 的启动前探针必须同时验证 Windows build、`sourceCaptureMode=process-exclusion`、`captureBackend=wasapi-process-exclusion`、`processLoopbackStatus=ready` 和 `excludedProcessId=Bridge PID`。指纹探针必须证明 Bridge 及其子进程的译音未进入 source pipe，而独立外部进程的原声仍被保留。
- process-exclusion 不安装、不修复、也不探测虚拟驱动；Bridge 的 source monitor 必须关闭，所有翻译语音只能走 Bridge translation pipe。
- echo-cancel 只有在固定版本 WebRTC AEC3 的 Windows x64 MSVC 静态构建和离线 fixture 门禁通过后才可启动。旧纯 Rust 算法与 shadow 双引擎路径不再存在；生产 ASR 只接收 AEC3 输出 PCM，任何 AEC 指标均不得触发字幕、译文或译音删除。
- echo-cancel 的译音由同一个 WASAPI render client 提交到物理端点，并从该 client 读取累计提交位置与 `GetCurrentPadding`。延迟估算使用 capture packet QPC age 与“当前 10 ms reference 之前”的真实 render lead；capture padding 用于校验 capture buffer 一致性，不能在 QPC age 已包含排队时间时重复相加。报告若仍显示 wall-clock/Rodio 推测或 `endpointRenderPadding=unavailable`，AEC 层必须判失败。
- 报告不得再把内容型 `echo-suppressed` 作为终态。文本相似度可用于诊断，但 `recent-output-echo`、`short-cjk-output-echo`、`echo-chain-fragment` 和播放后时间窗不能参与最终输出决策。
- 每条 translation frame 必须携带 cue id、创建时间、采样格式和预计时长；队列以预计开始播放时间执行 5 秒实时性预算，只淘汰尚未开始的最旧 cue，不中断当前播放。

## 2026-06-05 迭代约束

> 以下 2026-06-05/2026-07-26 条目是历史行为记录；其中“两变体默认矩阵”、文本回声门控和旧 AEC 抑制规则已被上面的 2026-08-10 三路线约束取代。

- 完整证据变体（默认 `-FeedbackLoopPrevention virtual-driver`）的 live 诊断 autostart 必须使用 `devices.feedbackLoopPrevention=virtual-driver`。如果使用 `echo-cancel`，应用仍可能把音频送入 Omni websocket，但 bridge `sourceSubscriberActive` 会一直为 false，原声 monitor 不会写入物理设备，无法证明用户能听到原声。因此 echo-cancel 只能作为独立变体运行，不能替代 virtual-driver 的完整门禁证据。
- 前端 `VITE_OMNI_WATCH_MODE_AUTOSTART` 和 Tauri 后端 `OMNI_WATCH_MODE_AUTOSTART` 两条路径都必须设置同一组 watch 配置：`keepOriginalAudio=true`、`translatedAudioEnabled=true`、`monitorMode=original-and-translated`、`outputDeviceId=耳机 (iBasso-DC-Series)`。
- 报告归因优先级：认证、限流、配额这类硬 provider 错误仍归 `provider`；单次 timeout、网络抖动等 transient provider 错误不能盖过 `physicalOutputContent` 失败。若物理输出录音为 0 帧或内容不一致，应先修真实输出链路。
- live 报告必须同时检查启动前 `physical-output-probe.json` 和看片期间 `physical-output-content.json`。前者只能证明 bridge 可以向设备写 tone，不能证明 watch route 实际把原声/译音写到了用户耳机。

## 2026-06-05 120 秒尾窗与音质约束

- 历史 live 样例曾使用 30 秒播放窗口和 120 秒尾窗；当前严格门槛改为默认播放完整原创 WAV 素材，并保留 120 秒尾窗。测试必须能捕捉“媒体结束后仍持续复述/翻译”的错误，不能只在短尾窗内提前通过。
- `physical-output-recording.wav` 继续覆盖完整播放窗口和 120 秒尾窗；`physical-output-recording-source-window-16k-mono.pcm` 只截取播放窗口加 8 秒，用于验证原声可识别，避免超长录音提交给 realtime STT 后无响应。
- 报告新增 `app.subtitleQueue`：记录 cue 开始、final/forced 翻译写入、segment TTS 排队和播放时间，精确到秒；`cueOrderInversions > 0` 或明显重复 final 翻译应判为失败。
- 实时会话页的“字幕队列”必须显示每条 cue 的开始/结束时间，便于人工截图和自动报告互相对应。
- `physicalOutputContent.audioQuality` 必须记录 RMS、peak、crestFactor、clippingRatio、zeroCrossingRate 和 nonSilentRatio。削波属于 `physicalOutputContent` 失败；高 zero-crossing 先作为 `noiseRisk` 证据记录，后续结合听感样本再调成硬失败。
- watch mode 发送给 Omni realtime 前必须做 ASR 输入能量门限：有效音频结束后只允许短静音尾窗帮助服务端 VAD 收尾，不能把两分钟静音/残留帧持续 append 给模型。
- `physicalOutputContent.audioQuality` 还必须记录 `discontinuityRate` 和 `discontinuities`，用于捕捉 20ms 小 buffer 播放断裂造成的破碎噪声。
- bridge monitor 不应把每个 20ms 原声帧都作为独立 rodio source 播放；应聚合为约 100ms source buffer，以降低用户态调度抖动。
- Omni/STT 的 48k stereo -> 16k mono 输入降采样不能简单抽取每 3 个样本中的 1 个；应至少做 3 点平均，降低混叠后再交给 realtime ASR。
- `duplicateFinalTranslations` 只统计较长 final 文本的实质重复；短感叹词和短连接句可记录在事件里，但不应单独导致 live 失败。

## 2026-07-26 echo-cancel 变体

- `run-watch-mode-live.ps1` 支持 `-FeedbackLoopPrevention process-exclusion|virtual-driver|echo-cancel`（默认 virtual-driver），贯通 `.env.local` 的 `VITE_OMNI_WATCH_MODE_FEEDBACK_LOOP_PREVENTION`、进程/用户环境变量 `OMNI_WATCH_MODE_FEEDBACK_LOOP_PREVENTION` 和 SkipDesktopLaunch 的 Tauri CLI config 三条注入路径；非 virtual-driver run 的输出目录带路线后缀，避免证据互相遮蔽。
- echo-cancel 变体下 bridge 无 source subscriber、原声不写物理设备，报告分类器把 `bridge`、`physicalOutput`、`physicalOutputContent`、`speechSegmentation`、`strictContent` 标记为 `skipped`，仍要求 `driver`、`wasapi`、`app`、`provider` 通过；核心通过条件是 app 层 `duplicateFinalTranslations` 检测器（任何实质重复 final 翻译即失败）。
- `report.json`、`snapshots.json`、`latest-watch-mode-live.json` 都记录 `feedbackLoopPrevention`；verifier 通过 `--feedback-modes` 按 模型 × 变体 校验，未指定时默认只认 `virtual-driver`，旧报告缺字段时也按 virtual-driver 处理。
- `npm run test:watch-mode-live:dry-run` 会对三种路线各做一次 config 注入探针并写入 `config-injection.json`，注入不一致直接失败；产物始终是 non-live fixture evidence。

## 2026-06-05 低延迟二次翻译回归

- 二次翻译路线允许较短的 forced 分句先显示临时译文：`MIN_FORCE_CHARS=28`、`MIN_FORCE_WORDS=6`、`MIN_FORCE_GROWTH_CHARS=18`。forced 片段只用于字幕低延迟预览；副翻译语音仍只播放 `pending=false` 的最终 segment。
- 字幕写入层必须去重较长最终译文。`Final` 和 `Replacement` 写入成功后记录 normalized translation key，后续 ASR revision 或 slot 重排再次返回同一较长译文时跳过；短感叹句不作为去重 key，避免误伤合法重复。
- live 报告的 app 层门槛保持：secondary 路线首个可见翻译应不超过 8 秒，首个最终翻译应不超过 15 秒，`duplicateFinalTranslations` 必须为 0。
- 历史通过样例：`artifacts/testing/watch-mode-live/20260605-103543/`，`verdict=passed`，`translationRoute=secondary`，`firstVisibleTranslationLatencySeconds=7`，`firstFinalTranslationLatencySeconds=7`，`duplicateFinalTranslations=0`，`queuedSegmentCount=10`，`playedSegmentCount=10`。该样例不包含当前双模型 strictContent 门槛。
- 同一次历史样例的物理输出内容通过：`physicalOutputContent.contentConsistency.coverage=0.938`，`lengthRatio=1.016`，`audioQuality.noiseRisk=false`，`clippingRatio=0`，`discontinuityRate=0.000055`。这证明当时的 30 秒源音频加 120 秒尾窗没有复述成超长输出，且录到的 iBasso 物理输出没有削波或明显断裂。

## 2026-06-05 原声音质相似度约束

- live runner 播放测试媒体时必须同时生成 `source-media-reference-16k-mono.pcm`。该文件由 `omni-watch-media-injector.exe --reference-pcm16k-mono-path` 从同一份原创 WAV 素材解码得到，避免依赖 ffmpeg 或与实际播放不同的解码器。
- `physical-output-recording-source-window-16k-mono.pcm` 与 `source-media-reference-16k-mono.pcm` 必须做 20ms RMS 包络相关。结果写入 `physicalOutputContent.originalPassthrough.sourceSimilarity`，至少包含 `envelopeCorrelation`、`levelRatio`、`bestOffsetSeconds`、`referenceFrames`、`recordedFrames`。
- `originalPassthrough.passed` 需要同时满足 STT 可识别和 source similarity 通过。若相似度失败，报告归因到 `physicalOutputContent`，典型原因是 `physical output original passthrough does not resemble source media reference: correlation=... levelRatio=...`。
- 当前保守门槛：`envelopeCorrelation >= 0.35` 且 `0.05 <= levelRatio <= 8.0`。这只拦截明显失真、录错设备、全静音或严重电平异常；后续若收集到更多主观“音质差”样本，再收紧阈值或增加频谱相似度。
- 通过样例：`artifacts/testing/watch-mode-live/20260605-104606/`，`verdict=passed`，`sourceSimilarity.envelopeCorrelation=0.9309`，`levelRatio=0.4148`，`bestOffsetSeconds=0.18`，同时 `firstVisibleTranslationLatencySeconds=6`，`firstFinalTranslationLatencySeconds=7`，`duplicateFinalTranslations=0`。
## 2026-06-05 二次字幕译音与输出音量回归

- 音频路由页的「听对方 · 二次字幕译音」不是独立的音频翻译 LLM。它必须强制 `speech.translationAudioSource=subtitle-tts`，消费「字幕翻译」卡片生成的最终 `pending=false` 句段，再交给 TTS 播放。
- 打开「用二次字幕生成译音」时，配置应同时满足：`devices.outputSpeechEnabled=true`、`devices.subtitleTranslationMode=secondary`、`speech.translationAudioSource=subtitle-tts`、`devices.subtitleTranslationModelId` 非空。
- secondary 路线的 TTS provider 应优先使用 `devices.inboundSecondaryAudioModelId`，不能退回到回复对方或通用 TTS 模型；字幕文本翻译仍使用 `devices.subtitleTranslationModelId`。
- 点击看片后，前端应先调用 `preconnect_omni_realtime` 建立 Omni websocket，再继续 bridge/driver readiness 和 `start_audio_route`。正式 route 启动时必须复用预连接 sender，并在日志中出现 `watch_mode.omni_preconnect_started` 和 `watch_mode.omni_preconnect_reused`。
- `devices.outputLevel` 必须同时影响本地扬声器播放和虚拟麦克风写入。回归测试需要覆盖 `outputLevel=0/50/100`，确认 `speech.speaker_playback_written` 的 `outputLevel` 变化，并确认虚拟麦克风 PCM 在写入前按同一比例缩放。
- 针对 2026-06-05 11:42:36 后的日志，首个字幕 LLM 调用约在 speech start 后 3.5s，首个字幕写回约 6.8s；Omni 原生音频首包约 43.8s。secondary subtitle-tts 路线的目标是优先播放二次字幕最终句段，避免用户等待 Omni 原生音频整段返回。
- 2026-06-05 12:21 实测二次字幕译音链路：`speech_started` 后 69ms 收到首个英文转写 delta，692ms `transcription.completed`，806ms forced sentence ready，891ms `[LLM_CALL]`，897ms DeepSeek start，2741ms DeepSeek output/end，2779ms 首个 `TRANS_WRITE`。随后 `speech.segment_tts_queued` 出现在 12:21:46.224，`speech.segment_tts_requested` 出现在 12:21:46.230，`speech.speaker_playback_written` 出现在 12:21:51.850，`译音输出完成` 出现在 12:21:55.717，且 `speakerFrames=92400 virtualMicFrames=92400`。
- `omni-physical-output-probe` 的 `default` 解析若命中 `Omni Translate Virtual Speaker`，必须自动回退到第一个非 Omni render endpoint；手工 smoke 样例解析到 `SPDIF 接口 (2- Realtek USB2.0 Audio)`，`passed=true`，`playbackFramesWrittenAfter=96000`，`rms=0.07465893`，`toneComponent=0.09242013`。
- 2026-06-05 12:26 的 `SkipDesktopLaunch` live 样例不作为最终链路通过证据：当前 `omni-desktop-shell` 进程需要提权，runner 无法干净 stop/start route；同时 driver probe 报 `post-tone idle peak` 残留、bridge source pipe 后续断开，并出现一次 DeepSeek 15033ms transient timeout。该样例仍证明了 physical output probe 已能选中真实设备，且 app 层出现 `speech.segment_tts_queued/requested`。
- `SkipDesktopLaunch` 复用已有桌面进程时，如果 `start watch mode via existing desktop shell` 因提权/IPC 失败，runner 必须写入 `failure.json` 并停止 readiness/playback/录音采样。报告应优先归因为 `app` 层 runner failure，不能继续消费旧 `app.log` 中的 Omni/session/subtitle 证据。
## 2026-06-05 Omni audible-input/no-VAD evidence

- Elevated live sample: `artifacts/testing/watch-mode-live/20260605-185455/`.
- Passed layers: driver, wasapi, bridge, physicalOutput.
- Route evidence: `watch_mode.omni_preconnect_started`, `watch_mode.omni_preconnect_reused`, `subtitleTranslationMode=secondary`, `translationAudioSource=SubtitleTts`.
- Source media: `scripts/testing/fixtures/watch-mode-en-original.wav`, original synthetic English speech; source STT passed.
- Omni input evidence: `input_audio_buffer.append.summary` includes `audioRms.avg` around `0.18-0.28` and `audioRms.max` around `0.31-0.46`, well above local silence threshold `0.002`.
- Failure evidence: no `speech_started`, transcription delta, or subtitle cue was received for that run.
- Expected report attribution: `provider` with reason `audible audio was sent to Omni, but no VAD/transcription event was received`.
- Report rule: app log route config must override stale `snapshots.translationRoute=native`; high-frequency append summaries must not evict early `subtitleTranslationMode=secondary` / `translationAudioSource=SubtitleTts` evidence.

## 2026-06-05 Watch mode passed sample after Omni VAD fix

- Passed live sample: `artifacts/testing/watch-mode-live/20260605-191332/`.
- 该目录是历史通过样例，不代表当前工作区自动通过；普通诊断以最新完整 live report 为准，发布结论只认 canonical strict manifest 及 `npm run test:watch-mode-evidence:strict`。
- Command shape: `run-watch-mode-live.ps1 -SkipDriverRepair -AllowElevatedDesktopLaunch -PlaybackSeconds 12 -PostPlaybackWaitSeconds 24 -SessionReadyTimeoutSeconds 90`.
- Result: `verdict=passed`; layers `driver`, `wasapi`, `bridge`, `physicalOutput`, `physicalOutputContent`, `speechSegmentation`, `app`, and `provider` all passed.
- Route: `translationRoute=secondary`; app log confirms `subtitleTranslationMode=secondary`, `translationAudioSource=SubtitleTts`, `watch_mode.omni_preconnect_started`, and `watch_mode.omni_preconnect_reused`.
- Omni session: send `input_audio_format=pcm16`, wait for `session.updated` before releasing queued audio, use `turn_detection.type=server_vad`, `threshold=0.0`, `silence_duration_ms=800`. This replaced the previous `semantic_vad` setup because watch-mode media is system playback/scene audio, not direct conversational speech; semantic VAD could delay or suppress detection.
- Latency evidence from report: `firstVisibleTranslationLatencySeconds=0`, `firstFinalTranslationLatencySeconds=0`, `firstTtsQueuedLatencySeconds=1`, `firstPlaybackLatencySeconds=2`.
- Secondary TTS evidence: `queuedSegmentCount=3`, `playedSegmentCount=3`, `translatedSpeech.passed=true`.
- Physical output content evidence: `contentConsistency.passed=true`, `coverage=1`, `lengthRatio=0.895`; `originalPassthrough.passed=true`, `sourceSimilarity.envelopeCorrelation=0.4068`, `levelRatio=0.7472`; `audioQuality.passed=true`, `clippingRatio=0`, `noiseRisk=false`.
- Strict status: 该 12 秒样例现在会因为不是完整原创 WAV 素材且 segment 数不足而无法通过 `strictContent`。
- Report rule: when the same run marker appears multiple times, log slicing must start at the first marker occurrence. Otherwise early route config can be cut away and `translationRoute` can fall back to stale snapshot data.
