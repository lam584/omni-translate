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
8. 默认播放完整 `scripts/testing/fixtures/watch-mode-en-original.wav`；injector 完成后发布身份绑定的 input-complete，随后按 Provider 终态、播放队列、speaker 与 renderer/物理 receipt 证据结束，不再把固定 120 秒尾窗当作成功条件。
9. 使用真实 STT 对源音频生成基准转录并缓存；再对物理输出录音做 STT，把两份文本做内容一致性检查。
10. 对原创 WAV 素材增加 `strictContent` 层，用固定中文参考译文做确定性评分，拦截只覆盖开头、漏掉关键短语或把 `十亿美元` 误成 `一亿美元` 等严重数字错误。
11. 发布前严格证据门槛只覆盖精确模型 `qwen3.5-livetranslate-flash-realtime`。其他显式模型仍可用于非正式诊断，但不能进入 release authority。

## 核心命令

普通 dry-run，不需要管理员权限：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "& { . .\scripts\testing\run-watch-mode-live.ps1 -DryRun -Fixture pass }"
```

下面的 Omni 命令是非正式、显式模型诊断示例，不会产生 release authority：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\testing\run-watch-mode-live.ps1 -SkipDriverRepair -AllowElevatedDesktopLaunch -WatchModelId qwen3.5-omni-flash-realtime -PlaybackSeconds 0 -PostPlaybackWaitSeconds 120 -SessionReadyTimeoutSeconds 90 -MediaPath .\scripts\testing\fixtures\watch-mode-en-original.wav
```

正式单模型 × 三路线矩阵必须通过已签的单 worker production coordinator：

```powershell
npm run test:watch-mode-live:production-coordinator -- -- --workers-config artifacts/testing/watch-mode-local-worker.json --runtime-authority artifacts/testing/watch-mode-strict-runtime/<release>/strict-runtime-authority.json --local-isolation-authority artifacts/testing/watch-mode-local-isolation/<run>/local-isolation-manifest.json
```

npm 11 在 Windows 上会把通常单个 `npm run ... --` 后面的具名选项吞成 npm 配置；上面的第二个字面 `--` 是必需的。生产配置只接受一个本机 worker，不包含 SSH、known_hosts 或私钥字段；四个付费单元在同一交互会话中串行执行。

旧 `test:watch-mode-live:matrix` / `run-watch-mode-live-matrix.mjs` strict 入口已在 build、preflight 和任何 Provider 调用前 fail-closed，只用于提示迁移；不能再用于生成发布证据。

严格入口必须显式传入 `--workers-config`、`--runtime-authority` 和 `--local-isolation-authority`。worker JSON 必须绑定唯一真实 `default-speaker` profile、当前 clean workspace、VM UUID 和交互用户；USB 或其他端点只能进入显式的非正式诊断。平衡版固定复验 3 个零 Provider local-isolation 格，再串行运行 4 个 LiveTranslate paid 格；每个付费格都只允许精确模型 `qwen3.5-livetranslate-flash-realtime`。verifier 只读取本次签名 manifest，不扫描 output root 中的历史报告，也不迁移旧 schema 或历史证据。支持 Windows build 20348 及以上时，`process-exclusion` 是推荐路线；能力探测失败时该变体必须明确失败，不能静默改跑其他后端。
以下 process-exclusion 和 echo-cancel 的 Omni 命令同样只是非正式诊断，不产生 release authority：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\testing\run-watch-mode-live.ps1 -SkipDriverRepair -AllowElevatedDesktopLaunch -WatchModelId qwen3.5-omni-flash-realtime -FeedbackLoopPrevention process-exclusion -PlaybackSeconds 0 -PostPlaybackWaitSeconds 120 -SessionReadyTimeoutSeconds 90 -MediaPath .\scripts\testing\fixtures\watch-mode-en-original.wav
```

单独跑非正式 echo-cancel 诊断变体：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\testing\run-watch-mode-live.ps1 -SkipDriverRepair -AllowElevatedDesktopLaunch -WatchModelId qwen3.5-omni-flash-realtime -FeedbackLoopPrevention echo-cancel -PlaybackSeconds 0 -PostPlaybackWaitSeconds 120 -SessionReadyTimeoutSeconds 90 -MediaPath .\scripts\testing\fixtures\watch-mode-en-original.wav
```

严格 evidence verifier：

```powershell
npm run test:watch-mode-evidence:strict
```

该命令固定读取 `artifacts/testing/watch-mode-live/latest-successful-watch-mode-strict-matrix.json`。发布验证采用预算平衡方案：复用 3 个零 LLM 本地隔离 authority，再运行 4 个严格 LiveTranslate 付费格。只有这 7 个格子的固定 authority 全部通过，本次 scoped verifier 才会原子替换 canonical manifest；失败、中断、single-device diagnostic 和 `-DryRun` 都不能覆盖它。旧的单进程 strict matrix 入口会在任何 Provider 调用前 fail-closed；正式入口是 `npm run test:watch-mode-live:production-coordinator`。

付费 live 矩阵不再声明统一的 Provider session 秒数。Provider 费用 authority 只按媒体派生的输入样本计数；`paidLlmSeconds=631.26125` 只是 `10,100,180 / 16,000` 的样本等价展示，不是 socket 墙钟、正常等待或会话 hard ceiling：

- `pairwise-live` + `model-stability`：共 4 格。virtual-driver/echo-cancel 每格 `2,013,045 + 160,000 = 2,173,045` 样本；process-exclusion 每格 `2,013,045 + 720,000 + 144,000 = 2,877,045` 样本；矩阵总上限 10,100,180 样本。
- strict paid 格只允许一次主实时 Provider 连接；source transcript、physical-output STT、secondary translation 和 secondary TTS 的远程调用均为 0。
- `local-isolation`：复用 3 个已验证格，Provider 完全禁用，`providerCalls=0`，不消耗 LLM token。

正式模型名以阿里云百炼官方文档 [Qwen3.5-LiveTranslate-Flash-Realtime](https://help.aliyun.com/zh/model-studio/qwen3-5-livetranslate-flash-realtime) 和指定的[百炼控制台文档 2983281](https://bailian.console.aliyun.com/cn-beijing?tab=doc#/doc/?type=model&url=2983281) 为准。结束顺序严格遵循同页“结束会话”：输入完成后只发送一次 `session.finish`，继续消费至 `session.finished`，再关闭 WebSocket；跳过该顺序会丢失尾部识别或翻译。

时序上必须区分媒体墙钟、Provider samples、本地 drain 与 watchdog。canonical reference 为 125.815333 秒，全模式 postroll 3 秒；process-exclusion 另在 90 秒处插入固定 45 秒 quiet window，因此媒体墙钟分别约 128.815 秒与 173.815 秒。180/225 秒只是各模式的 input-complete 失败上限。正常成功由 input-complete marker 驱动，Provider finish 上限 15 秒。本地播放 drain 的严格预算为 `min(ceil(pendingPcmFrames * 1000 / outputRateHz) + 2000ms 余量 + 750ms 连续稳定窗, 30000ms)`；缺帧数或输出率时使用配置值并夹在 15–30 秒内 fail-closed。renderer/物理 receipt 连续稳定 750ms 后立即写 immutable report。cell hard watchdog 也按模式派生：virtual-driver/echo-cancel 为 `180+15+30+10=235s`，process-exclusion 为 `225+15+30+10=280s`；它只给失败路径封顶。

`evidence-driven-terminal.json` 必须由真实生产 owner 逐项记录并由 verifier 验证 10 个原始阶段：`mediaPlaybackCompleted`、`inputCompleteSignaled`、`inputCompleteObserved`、`lastProviderAppend`、`sessionFinishSent`、`lastResponseAudioDone` 或 `responseDone`、`sessionFinishedReceived`、`localPlaybackQuiescent`、`finalRendererAck`、`reportWritten`。这是证据清单，不是强制 response terminal 晚于 `session.finish` 的伪偏序：LiveTranslate 会在输入过程中流式返回响应，因此最后 response terminal 可以早于 `sessionFinishSent`，但必须早于 `sessionFinishedReceived`并与最后 cue/renderer ACK 同一 lineage。signal 与 desktop observation 不能合并；`sessionFinishSent` 必须晚于最后一次合法 append 且 exactly-once，finish 后 Provider writes 必须为 0；必须收到 `session.finished`；最终 renderer ACK 必须覆盖最后 cue sequence；`reportWritten` 最后。缺失、重复、违反上述必要偏序、未知阶段或身份不一致均 fail closed。

外层超时只包络失败清理，不制造正常等待。当前最坏模式 runner 内部由 `90s readiness + 280s cell hard + 30s report receipt + 20s scheduling` 派生；shard、远端单格和 production coordinator 再逐层叠加 pre/post cleanup、dispatch/receipt、下载与 post-preflight margin。代码只以阶段预算公式为 authority；当前计算值 578/620 秒和下载包络 300 秒只是派生结果，不能作为正常成功等待或另一个固定 session floor。

正式协调器的固定顺序是：一次 release build → 单 worker 零 Provider readiness（clean HEAD/runtime、驱动、endpoint/profile、Credential Manager 引用）→ 复核 3 格 local-isolation authority → 签发 preflight grant 与 4 个唯一预算 reservation → 对精确 LiveTranslate 模型执行一次 text-only、0-audio production preflight → 签发 completion/final plan → 串行执行 4 个付费格。任何 readiness、凭据、有效期余量或本地 authority 失败都会在 preflight 前停止；preflight 的输入/输出 token 上限为 4096/256，成功后也不会重新分配 lease。

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
- `../latest-successful-watch-mode-strict-matrix.json`: 最近一次成功完成 scoped strict 验证、并与当前 clean `HEAD` 精确绑定的预算平衡 canonical manifest（3 个零 LLM 本地格 + 4 个付费 LiveTranslate 格）。
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

不要把仓库根目录下的 `report.json` 或 `report.md` 当作当前项目状态来源。普通本地诊断用 `npm run test:watch-mode-evidence` 扫描 `artifacts/testing/watch-mode-live/<timestamp>/report.json`；发布前严格证据只认 canonical manifest 绑定的本次 3 个本地 authority 格和 4 个 LiveTranslate 目录，禁止从 output root 自动挑选历史报告补格。

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

普通 `npm run test:watch-mode-evidence` 会扫描 `artifacts/testing/watch-mode-live/*/report.json`，并跳过 `cache`、`physical-output-smoke-*`、`reference-pcm-smoke-*` 等非完整 live 目录。严格命令不执行这种扫描，只读取 canonical manifest 精确绑定的 4 份 LiveTranslate paid report 和 3 格本地隔离 authority。它按 `cellId/tier` 重验精确模型、三路线、唯一 session、每格样本 lease、10 个 raw terminal stages、最后 cue 的 renderer/物理 receipt、report/manifest provenance 与当前 clean `HEAD` 完全一致，以及 `strictContent.passed=true`；正常成功不再依赖统一的分钟数下限。ancestor commit、生成时 dirty、验证时 dirty 或未跟踪源码都会失败。普通 `npm run quality:gate` 不会启动真实硬件链路；`release:verify` 会额外执行严格 evidence 门禁。

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

随后 runner 会在播放测试音频前启动物理输出录音。完整播放后，desktop 完成 Provider `session.finished` 与本地播放/renderer receipt 终态并写出 terminal marker；录音器再保留 1–2 秒物理尾段后主动停止，只有 terminal marker 缺失时才使用按 cell watchdog 派生的 hard cap。录音随后提交给同一个 STT 诊断程序。`physical-output-content.json` 会包含：

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

## 2026-08-14 Plus 丢失事故专项与收尾顺序

原始 `qwen3.5-omni-plus-realtime` Watch Session 曾同时出现三类故障：历史文本回声原因码误拦截非空 final、单条 native `Play` 超过实时预算、以及播放回灌/AEC/端点时钟异常可能掩盖真实输入。当前回归基线是脱敏的十四事件 replay fixture；它覆盖 `recent-output-echo`、`echo-chain-fragment`、`short-cjk-output-echo` 三种历史状态形状。播放活跃或播放后四秒内的非空合法 final 都必须只触发一次 `response.create`，并保留已批准 cue、译文和后续播放链路。空文本、重复 completed、旧 response owner、旧 session 和已停止会话仍须拒绝。

真实付费验收必须严格分两阶段，顺序不可交换：

1. **Plus 事故专项。** 使用 `scripts/testing/run-watch-mode-incident-plus.mjs` 生成独立的 signed execution authority，产物位于 `artifacts/testing/watch-mode-incident-plus/<execution-id>/`。入口必须先以本次 coordinator 公钥 ID 重建 Desktop/Bridge/driver runtime，再签发 text-only preflight grant；否则当前 Desktop 会拒绝未编入自身的 grant。远端单格仅能由 `scripts/testing/run-watch-mode-incident-plus-cell.mjs` 经受哈希约束的 `incident-plus-cell` Interactive Session 启动。固定三格为 `qwen3.5-omni-plus-realtime` × process-exclusion/default-speaker、virtual-driver/USB、echo-cancel/default-speaker；前两格为第一波，AEC 格为第二波。每格 180 秒/2,880,000 个 16 kHz 样本，总计 540 秒/8,640,000 样本，辅助外部音频必须为零。专项有自己的三份 lease、text-only preflight grant/reservation/consumption claim、预算账本、manifest 和 verification receipt，绝不复用四格 release matrix 的任何授权或结果。

   `--dispatch` 是唯一会发起 Plus Provider 调用的显式开关；它要求 `--workers-config` 指向两台已钉住 SSH host key 的 VM、`--local-isolation-authority` 指向当前 clean commit 的 zero-provider authority。没有该开关时，脚本只执行当前 runtime 重建并签发准备包，绝不调用 Provider。执行中任一 first-wave 单元失败会取消同波剩余任务并禁止进入 AEC 第二波；三个结果仅在同一 coordinator 进程保留的私钥下写成 Plus manifest/verification receipt。
2. **固定四格严格发布矩阵。** Plus 三格只属于显式 incident 诊断；正式 `npm run test:watch-mode-live:production-coordinator` 只运行 LiveTranslate 的三路线 pairwise 与一个 process-exclusion stability 格。不得把 Plus 或 Omni Flash 加入、替换或缩减 `LIVE_LLM_CELLS`、`SHARD_MATRIX_CELL_COUNT = 4` 或严格 verifier。

两阶段前均需从最终 clean commit 重建并重做本地 authority：AEC3 MSVC、WebRTC fixture/release 绑定、Desktop/Bridge/必要 driver/probe runtime、local-isolation authority，以及两台 VM 的 zero-provider readiness（设备 profile、进程排除/虚拟驱动能力、Bridge source、Interactive Session、凭据可见性）。旧 `E:\omni-paid-execution-f2541ac` 仅作为失败历史，不可覆盖、删除或混入新 execution。

Plus 专项每格除既有报告层和 canonical source 严格内容校验外，还必须满足：非空 final 不出现上述三种历史文本原因；正常 stream 不出现 `native-playback-queue-expired`、`native-playback-queue-overflow` 或 `native-playback-stream-stale-dropped`；AEC 格须具有完整 AEC 诊断且没有异常 reset/underrun 或整段字幕/译文被吞掉。真正陈旧的独立 Play 可以拒绝，但报告必须包含 cue ID、预测开始时间和明确原因。

任一零费用门禁失败时停止进入 Provider 阶段，沿 `ASR final → manual gate → cue lifecycle → response.create → subtitle/translation` 或 `audio delta → stream batch → playback queue → Bridge receipt → Watch report` 调用链复现并补最小回归。任一付费格失败时停止该 execution 的后续 dispatch，保留计划、lease、日志、trace、预算和 VM 诊断；修复后从新的 clean commit、新 execution ID、新本地 authority/readiness/preflight 开始，完整重跑受影响的专项三格或严格四格，不能拼接旧结果。

`incident-plus-20260816-c7c2503-closeout-e` 是失败证据而非通过证据：第一波 virtual-driver/USB 在 Provider 返回 `<50002> InternalError.Algo.ModelServingError` 并关闭 socket 后严格拒绝重连，只发送约 12.8 秒输入；同波 process-exclusion 虽完成 180 秒输入和 8 个可见 cue，却在前一个长译音仍播放时把新的 stream `Start` 记录为 `native-playback-stream-stale-dropped`。反查后，stream 起点只按自身创建年龄执行五秒实时准入，不能用前序当前流的预计播放结束时间把新流判旧；独立 `Play` 仍按预计开始时间过期，队列容量仍受界。Provider delta 必须拆成最多一秒的 stream 命令，不能用 `take()` 把 1.28 秒或更大的瞬时缓冲当成“一秒批次”。对应零费用回归同时覆盖当前 Start 在长前序流后仍入队、真正旧 Start 仍拒绝、超大 delta 精确分批和 stale 诊断四个字段。

最后执行：

```text
npm run test:watch-mode-evidence:strict
npm run quality:gate:release
```

收尾 manifest 必须同时引用当前 commit 的 local-isolation manifest、worker readiness、Provider preflight receipt、Plus incident manifest/receipt、四格 shard manifest/strict verification receipt、运行时二进制哈希和两套预算账本。

### 2026-08-16 首轮失败证据如何重放

首轮 Plus 第一波不是发布通过证据。它证明了运行 180 秒不等于向 Provider 连续发送 180 秒：process-exclusion 与 virtual-driver 两格的 send-boundary ledger 只有约 48–50 秒输入，内容也只覆盖 canonical source 前段。当前零费用回归必须覆盖“manual response pending 时，ready websocket 继续接收 input audio”；只有 `commit/response.create` 被串行化，音频输入不能回退到会溢出的 pre-session queue。新付费 execution 必须重新生成 clean-commit local authority、readiness、preflight 和 lease，不能修补或拼接旧 execution。

物理内容 authority 的原声 matcher 现在按以下不变量重建：

- canonical reference、source-window 与完整 physical recording 都必须是受哈希约束的普通文件，source-window 必须是完整录音的精确前缀，不能复用 reference 路径或字节；
- 仍使用九个固定、互不重叠的时间锚点并至少通过七个，同时保留统一极性、错误参考 margin、能量范围和波形/一阶导数门槛；
- 全局 lag 只作为身份和极性锚点。每个锚点允许在 `±200 ms` 真实端点时钟范围内选择一个 200 ms 片段，输出 `anchorLagSamples`、`localLagSamples` 和 `localLagDeltaSamples`；
- 两份首轮真实 PCM 离线重建分别通过 `7/9`、`8/9`，而三锚点稀疏复制、同包络异频音、纯译音 tone、噪声、错误参考和伪造前缀仍必须失败。

`translated-pcm-loopback-correlation` 对不完整 cue 采用“严格失败但继续诊断”：缺少唯一有序 queued/started/completed 的 cue 仍写 violation，其他完整 cue 继续产生相关性、wrong-cue margin 和物理时间窗结果。排查时先看 `translated-cue-pcm-summary.json` 的 finalized/terminalReason/active/aborted 状态，再看逐 cue lifecycle；不能把 `matchedCueCount=0` 当作唯一结论。

真实执行的优先字段顺序为：

1. `provider-input-budget-ledger.json` 与 Rust send-boundary ledger 的 `totalSamples`、`finalized`、`terminalReason`、model/protocol/lease identity；
2. Watch report 中 canonical coverage、完整可见 cue 数、`historicalRegressionChecks` 和历史三类文本回声原因；
3. `native-playback-queue-expired`、`native-playback-queue-overflow`、`native-playback-stream-stale-dropped` 的 cue、预测开始时间和实际年龄；
4. translated PCM summary/journal、逐 cue 物理 matcher、原声九锚点 candidate 与 wrong-reference margin；
5. echo-cancel 的 render submit position、endpoint padding、capture QPC age、AEC reset/underrun 和 ASR deleted chunks。

## 2026-06-05 迭代约束

> 以下 2026-06-05/2026-07-26 条目是历史行为记录；其中“两变体默认矩阵”、文本回声门控和旧 AEC 抑制规则已被上面的 2026-08-10 三路线约束取代。

- 完整证据变体（默认 `-FeedbackLoopPrevention virtual-driver`）的 live 诊断 autostart 必须使用 `devices.feedbackLoopPrevention=virtual-driver`。如果使用 `echo-cancel`，应用仍可能把音频送入 Omni websocket，但 bridge `sourceSubscriberActive` 会一直为 false，原声 monitor 不会写入物理设备，无法证明用户能听到原声。因此 echo-cancel 只能作为独立变体运行，不能替代 virtual-driver 的完整门禁证据。
- 前端 `VITE_OMNI_WATCH_MODE_AUTOSTART` 和 Tauri 后端 `OMNI_WATCH_MODE_AUTOSTART` 两条路径都必须设置同一组 watch 配置：`keepOriginalAudio=true`、`translatedAudioEnabled=true`、`monitorMode=original-and-translated`、`outputDeviceId=耳机 (iBasso-DC-Series)`。
- 报告归因优先级：认证、限流、配额这类硬 provider 错误仍归 `provider`；单次 timeout、网络抖动等 transient provider 错误不能盖过 `physicalOutputContent` 失败。若物理输出录音为 0 帧或内容不一致，应先修真实输出链路。
- live 报告必须同时检查启动前 `physical-output-probe.json` 和看片期间 `physical-output-content.json`。前者只能证明 bridge 可以向设备写 tone，不能证明 watch route 实际把原声/译音写到了用户耳机。

## 2026-06-05 历史 120 秒尾窗与当前终态约束

- 历史 live 样例曾使用 30 秒播放窗口和固定 120 秒尾窗。当前严格门槛播放完整原创 WAV，并要求上文 10 个独立 raw stages 的身份绑定、单调顺序和 exactly-once/zero-write/last-cue-ACK 不变量；不再用 `providerShutdownConfirmed` 聚合项替代原始 Provider 阶段。没有 terminal evidence 就失败，不能靠缩短尾窗提前通过。
- `physical-output-recording.wav` 覆盖完整播放并在 desktop terminal/report marker 后保留 2 秒 tail 主动停止，另有独立 hard cap；`physical-output-recording-source-window-16k-mono.pcm` 仍只用于原声 authority，不把超长录音交给远程 STT。
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
- 历史通过样例：`artifacts/testing/watch-mode-live/20260605-103543/`，`verdict=passed`，`translationRoute=secondary`，`firstVisibleTranslationLatencySeconds=7`，`firstFinalTranslationLatencySeconds=7`，`duplicateFinalTranslations=0`，`queuedSegmentCount=10`，`playedSegmentCount=10`。该样例不包含当前 LiveTranslate-only release authority 与 strictContent 门槛。
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
