# 百炼模型协议注册表 v1

审计日期：`2026-08-30`。本注册表只使用阿里云百炼官方资料，所有 fixture
均已脱敏，不包含凭据、真实媒体或付费调用。

## 目标与硬不变量

百炼的 transport、endpoint family、wire dialect 与产品能力是四个正交维度。
`WebSocket` 或 `/api-ws/v1/realtime` 不能授权某种事件状态机；模型名包含
`audio`、`realtime`、`asr` 或 `tts` 也不能授权能力或付费连接。

任何资源创建前必须由
`authorizeModelProtocolInvocation`（TypeScript）或
`authorize_model_protocol_invocation`（Rust）返回完整 authority：

```text
registryVersion + exactModelId + profileId + profileVersion + product +
operation + transport + region + endpointFamily + endpointPath +
endpointHost + endpointHostFamilyId +
wireDialect + wireDialectVersion + input/output framing +
turn/commit/response semantics + per-event text semantics + audio spec +
client/server event and framing allowlists + terminalLifecycle +
adapterId + wireFixture
```

函数输入至少包含精确 `modelId + operation + transport + region + endpointHost`，还可声明
预期 registry/profile/version/dialect/endpoint/terminal。返回值是完整 authority
或稳定 `model_protocol.*` 错误，不返回含糊的布尔值。匹配区分大小写且不
trim；不使用 substring、family wildcard、provider template 或 capability
fallback。未登记快照与未知模型统一为 `model_protocol.model_not_registered`。

socket 收发事件必须再由 `admitModelProtocolEvent`（TypeScript）或
`admit_model_protocol_event`（Rust）检查完整 authority、client/server allowlist
及应用层 frame kind，然后才能修改 cue、report、playback 或 lifecycle 状态。

前端配置中的 `modelProtocolProfile` 是 manifest 的只读投影，包含 product、
operations、transport、endpoint family/path、wire dialect、input/output framing、
terminal lifecycle 与 adapter status。它用于让 UI 不再把所有百炼语音产品压成
`RealtimeProtocol`，但它本身不授予连接：生产 authority 仍由精确
`registryVersion + profileId + profileVersion + modelId` 回到 manifest 重新解析。
旧 `realtimeProtocol` 只保留为非百炼兼容路径的迁移字段，百炼 seed 不得用它
陈述 Qwen-Audio、task ASR/TTS 或其他 manifest-only 产品。

Rust 另提供只读的
`lookup_model_protocol_profiles_for_inspection`。它用于诊断 manifest-known 条目，
会返回 adapter status 与完整 endpoint/dialect metadata，但**绝不**授予连接；
`manifest-only` 条目仍必须由 `authorize_model_protocol_invocation` 返回
`model_protocol.adapter_unavailable`。

## v1 协议矩阵

| 产品/operation | Transport / endpoint | Wire dialect / framing | 握手与 turn control | preview / commit | terminal | v1 状态 |
|---|---|---|---|---|---|---|
| LiveTranslate / `native_translate` | WS `/realtime`, model query | LT session；输入/输出 JSON Base64 | `created → update → updated`；VAD 或 manual commit，commit 自动触发 | `text+stash` 按 response identity replace；`.done` commit | `session.finish → session.finished` | 仅精确 `qwen3.5-livetranslate-flash-realtime` adapter-enabled；其他已知快照 manifest-only |
| Qwen-Omni / `dialogue`,`native_translate` | WS `/realtime`, model query | Omni session；JSON Base64 | manual commit 后 `response.create` | 输入转写 `.delta` 的 `text+stash` replace；输出文本/字幕/function args `.delta` append；`response.done` 只结束一轮 | owner 在 response drain 后 close；不虚构 `session.finished` | manifest-only；Qwen3.5 stable/`2026-03-15` 快照独立 profile，PCM/WAV 8/16/24/48k；旧 Qwen3/Qwen-Omni 不继承该媒体 authority |
| Qwen-Audio 3.0 / `dialogue` | WS `/realtime`, model query | Qwen-Audio chat；JSON Base64 | PTT/VAD/smart_turn 独立状态 | input/ambient transcription `.delta` 的 `text+stash` replace，response `.delta` append；`turn_invalid` 是 `input_audio_buffer.speech_stopped.reason`，不是事件类型 | owner close after drain | manifest-only |
| Qwen-ASR Realtime / `asr` | WS `/realtime`, model query | ASR session；JSON Base64 input | VAD 或 manual commit | transcription `text+stash` replace；completed commit | `session.finish → session.finished` | manifest-only，当前 STT close 路径尚未对齐 |
| Qwen-Audio-3.0-ASR-Flash-Streaming / `asr` | WS `/inference`, model payload | 独立 Qwen-Audio task ASR profile/fixture；JSON control + Binary input | `run-task → task-started` 后才可发音频 | `task_id + sentence_id` identity replace；`sentence_end=true` commit；任意正整数采样率 | `finish-task → task-finished`；成功后可用新 `task_id` 顺序复用，失败连接失效 | manifest-only；与 Fun-ASR 共用官方事件页面但不共用产品 profile/fixture |
| Fun-ASR-Realtime / `asr` | WS `/inference`, model payload | 独立 Fun-ASR task profile/fixture；JSON control + Binary input | `run-task → task-started` 后才可发音频 | `task_id + sentence_id` identity replace；`sentence_end=true` commit；任意正整数采样率 | `finish-task → task-finished`；成功后可用新 `task_id` 顺序复用，失败连接失效 | manifest-only；参数能力不得从 Qwen-Audio-ASR 继承 |
| Paraformer / `asr` | WS `/inference`, model payload | Paraformer task；JSON control + Binary input | task-started gate；参数 schema 独立 | `task_id + begin_time` identity replace | `finish-task → task-finished`；成功后可顺序复用 | manifest-only；按 exact model 拆 profile：v2 任意正整数采样率、v1 仅 16k、8k-v1/v2 仅 8k；不可拿 Fun fixture 代替 |
| Gummy legacy / `asr`,`native_translate`(text) | WS `/inference`, model payload | Gummy task；JSON control + Binary input | task-started gate | transcription/translation identity 独立，fixed 部分稳定 | `finish-task → task-finished`；成功后可顺序复用 | legacy manifest-only |
| Qwen-Audio-TTS/CosyVoice / `tts` | WS `/inference`, model payload | SpeechSynthesizer duplex task；JSON text + Binary output | `run-task → task-started → continue-task*` | result event 绑定后续 binary audio | `finish-task → task-finished`；成功后新 `task_id` 顺序复用，失败连接失效 | manifest-only；Qwen-Audio-3.0 与 CosyVoice v3.5/v3/v2 按 exact model/region 拆 profile |
| Sambert / `tts` | WS `/inference`, model payload | one-shot task；text 在 run-task，Binary output | `run-task(streaming=out)` | task output commit | server `task-finished` 后可用新 `task_id` 顺序复用；不发 duplex continue/finish | manifest-only；v1 只登记官方示例精确 model |
| Qwen3-TTS Realtime / `tts` | WS `/realtime`, model query | TTS session；JSON text + Base64 audio | `input_text_buffer.append/commit` | audio `.delta` append，audio done commit | `session.finish → session.finished` | manifest-only；北京/新加坡，输出 pcm/wav/mp3/opus，8/16/24/48k |
| legacy Qwen-TTS Realtime / `tts` | WS `/realtime`, model query | 同一 session wire family，但产品媒体约束独立 | `input_text_buffer.append/commit` | audio `.delta` append，audio done commit | `session.finish → session.finished` | legacy manifest-only；仅北京、PCM 24k，不继承 Qwen3 codec/rate |
| multimodal-dialog / `dialogue` | WS `/inference`, model payload | 外层 `header.action/event` task envelope + 内层 `payload.input.directive/output.event`，另有 Binary media | `run-task/Start → result-generated/Started` 后仍不可发音频；必须等 `result-generated/DialogStateChanged(state=Listening)` | app state owns commit | `finish-task/Stop → result-generated/Stopped`；60s server-silence timeout | manifest-only |
| LiveTranslate file / `file_translate` | HTTP+SSE `/chat/completions` | OpenAI-compatible chat delta | 单 request | `choices[].delta` append | `[DONE]` | 已审计但 v1 未登记，fail closed |
| 非 realtime ASR/TTS / `asr`,`tts` | family-specific HTTP/SSE | family-specific | request/async task | family-specific | HTTP/SSE/async terminal | 已审计但 v1 未登记，fail closed |
| voice clone / `voice_clone` | family-specific HTTP management | product-specific CRUD | create/list/delete | voice identity commit | HTTP terminal | 已审计但 v1 未登记；后续 authority 必须含 exact target_model + region |
| AOQ/WebRTC | AOQ/WebRTC | transport-specific | transport-specific | 不从 WS 推断 | transport-specific | v1 未登记，fail closed |

`manifest-only` 表示产品和 wire contract 已知，但生产 adapter 未通过独立 typed
state machine/fixture 验证。它仍会在 connect/付费前返回
`model_protocol.adapter_unavailable`，不能因 manifest 中存在条目而自动放量。

## 生产者、消费者与资源所有权

- manifest 是 model/product/protocol identity 的生产者；UI capability 只能给出
  建议，不能反向写入 authority。
- route resolver、endpoint builder 与 dialect adapter 是消费者；三者必须传递
  同一 authority，不能各自从模型名重建。
- transport owner 只有在 authority 成功后才能记录 attempted 并创建 socket。
- dialect adapter 独占 ready、input accepted/committed、output preview/committed
  与 protocol terminal 状态。
- playback owner 记录 played，不得用 provider response、缓存或 queued 代替。

事件偏序：

```text
profile_resolved < invocation_authorized < transport_attempted <
transport_accepted < protocol_ready < input_accepted* < input_committed <
output_preview* < output_committed < played? < protocol_terminal < close
```

原始证据边界：

- attempted：transport owner 在 connect/send 前记录完整 authority + attempt id。
- accepted：WS upgrade/协议 ready ACK，以及每帧 send 完成的 sequence/bytes/framing。
- committed：对应 dialect 的 `.done`/completed/task final/terminal 原始事件。
- played：speaker/bridge owner 的 cue/request、device generation、frames/rate/channel
  与起止单调时间。

## Endpoint 与 region

`endpointFamily` 定义 path、model placement 与 wire contract；独立的
`endpointHostPolicies` 按 region 授权 host family。当前 v1 只允许：

- `cn-beijing`：`dashscope.aliyuncs.com` 或单标签
  `*.cn-beijing.maas.aliyuncs.com`；
- `ap-southeast-1`：`dashscope-intl.aliyuncs.com` 或单标签
  `*.ap-southeast-1.maas.aliyuncs.com`。

业务空间专属域名是生产推荐项，但北京/新加坡各自的通用 DashScope 域名仍是
官方支持入口；`WorkspaceId` 不是授权必填项。反之，host 不能从 region 独立选择：
`cn-beijing × dashscope-intl.aliyuncs.com`、嵌套多标签伪 workspace host、以及
region/API Key/model/endpoint 任一跨地域组合都必须在 connect/付费前失败。

## 本轮事实修正与启用优先级

| 优先级 | 事实修正 | 官方 source（均 `checkedAt=2026-08-30`） | 最小失败向量 / fixture mutation | 启用策略 |
|---|---|---|---|---|
| 立即修正 manifest 元数据 | task 成功终态后同连接顺序复用；每个新任务必须使用新 `task_id`；失败关闭且不可复用 | [实时 TTS 连接复用](https://help.aliyun.com/zh/model-studio/realtime-tts-user-guide)、各 task 产品 server-event 页（例如 [Fun-ASR](https://help.aliyun.com/zh/model-studio/fun-asr-server-events)） | 第二个 `run-task` 早于首个 `task-finished`、复用旧 `task_id` 或 `task-failed` 后再发任务均被 fixture contract 拒绝 | 所有 task adapter 都必须保存 connection owner 与 task owner 的分层身份 |
| 必须独立拆 profile | Paraformer 四个 exact model 的采样率不同 | [Paraformer client events](https://help.aliyun.com/zh/model-studio/paraformer-client-events) | `paraformer-v1-rejects-8khz`、`paraformer-v2-allows-44100-before-adapter-gate`、`paraformer-8k-v2-rejects-16khz` | adapter 启用前不得合并回 family profile |
| 必须独立拆 profile | CosyVoice v3.5/v2 与 v3 地域不同 | [实时语音合成地域表](https://help.aliyun.com/zh/model-studio/realtime-tts-user-guide) | `cosyvoice-v3.5-is-not-in-singapore`、`cosyvoice-v3-is-registered-in-singapore` | exact model + region 决定 profile |
| 必须独立拆 profile | Qwen3-TTS 与 legacy Qwen-TTS codec/rate/region 不同 | [Qwen-TTS client events](https://help.aliyun.com/zh/model-studio/qwen-tts-realtime-client-events)、[实时语音合成地域表](https://help.aliyun.com/zh/model-studio/realtime-tts-user-guide) | `qwen3-tts-opus-48k-is-valid-before-adapter-gate`、`legacy-qwen-tts-rejects-opus`、`legacy-qwen-tts-is-not-in-singapore` | wire family 可共享 transport，但媒体 authority 不共享 |
| 必须独立拆 profile | Qwen3.5-Omni 可配置 PCM/WAV 8/16/24/48k，旧 Omni 不能按模型名继承 | [Omni client events](https://help.aliyun.com/zh/model-studio/client-events) | `qwen35-omni-48k-media-is-valid-before-adapter-gate`、`legacy-omni-does-not-inherit-qwen35-media-authority`、未知快照拒绝 | 保持同一 wire family、分代 modelAudio/profile；两者均 manifest-only |
| 必须消除 UI 错配 | Qwen-Audio 3.0 Realtime 是 dialogue product，不是 Omni dialect，也不是 native translation | [Qwen-Audio 用户指南](https://help.aliyun.com/zh/model-studio/qwen-audio-realtime-user-guides) | seed 同时断言 `operations=[dialogue]`、Qwen-Audio wire dialect、`realtimeProtocol` 缺省；声明 Omni dialect/native_translate 均拒绝 | manifest-only，直到独立 smart_turn/ambient/turn_invalid adapter 完成 |
| 仅在启用 adapter 前阻断 | multimodal-dialog 是双层 envelope，`Started` 不是媒体 ready | [多模态交互协议](https://help.aliyun.com/zh/model-studio/multimodal-interaction-protocol) | bare `Start`、缺外层 `run-task`、或将唯一 `Listening` 改成 `Thinking` 都被 fixture contract 拒绝 | 保持 manifest-only，直到独立 typed adapter/state machine 通过同一 fixture |

## 官方歧义与保守口径

1. Qwen-ASR 目录对媒体 framing 的概述与事件参考存在表述差异；v1 session
   profile 采用事件参考中的 JSON Base64，task ASR 采用 Binary。
2. LiveTranslate 页面把 `response.text.text` 称为“增量”，但 `text+stash` 会整体
   更新；v1 按 replaceable snapshot 处理，`.done` 才 commit。
3. 事件名后缀不能授权合并算法：Omni/Qwen-Audio 的输入转写事件虽然名为
   `.delta`，其 `text+stash` 仍是可替换快照；只有逐事件 registry 语义可决定
   replace 或 append。
4. Qwen-Omni 当前用户指南出现可发送 `session.finish` 或直接断开的表述，但
   server event reference 没有与 LiveTranslate 等价的 `session.finished` 全局 ACK。
   v1 不授权 `session.finish → session.finished` 终态，也不会把 `response.done`
   当作会话终态；该 profile 在 typed adapter 完成前保持 manifest-only。
5. Sambert 是 one-shot task，不发送 duplex `continue-task/finish-task`；不能因为
   endpoint 与 CosyVoice 相同就复用 duplex lifecycle。
6. task 产品的连接与任务不是同一个身份层级：`task-finished` 只终结当前
   `task_id`，成功后连接可承载下一个不同 `task_id`；`task-failed` 则终结连接复用权。

## 官方资料

每个 dialect/profile 与 fixture 均在
[`contracts/model-protocol-profiles.v1.json`](../../contracts/model-protocol-profiles.v1.json)
内记录精确 source URL 和 `checkedAt=2026-08-30`。总览入口：

官方 client/server 页面标题的密封清单另见
[`contracts/model-protocol-official-event-catalog.v1.json`](../../contracts/model-protocol-official-event-catalog.v1.json)。
验证器要求每个 allowlist 与“官方事件标题（或成文 protocol message type）+
明确的 binary frame pseudo-event”精确相等：既不能漏掉合法控制事件，也不能
夹带其他 dialect 的事件。

- https://help.aliyun.com/zh/model-studio/realtime-api-overview
- https://help.aliyun.com/zh/model-studio/omni/
- https://help.aliyun.com/zh/model-studio/asr-model
- https://help.aliyun.com/zh/model-studio/tts-model
- https://help.aliyun.com/zh/model-studio/realtime-api-aoq-sdk-desc/
- https://help.aliyun.com/zh/model-studio/regions
- https://help.aliyun.com/zh/model-studio/qwen3-5-livetranslate-flash-realtime
- https://help.aliyun.com/zh/model-studio/live-translator-client-events
- https://help.aliyun.com/zh/model-studio/live-translator-server-events
- https://help.aliyun.com/zh/model-studio/qwen3-livetranslate-flash
- https://help.aliyun.com/zh/model-studio/qwen3-livetranslate-flash-api
- https://help.aliyun.com/zh/model-studio/realtime
- https://help.aliyun.com/zh/model-studio/client-events
- https://help.aliyun.com/zh/model-studio/server-events
- https://help.aliyun.com/zh/model-studio/qwen-audio-realtime-user-guides
- https://help.aliyun.com/zh/model-studio/fun-audiochat-realtime-websocket-api
- https://help.aliyun.com/zh/model-studio/fun-audiochat-client-events
- https://help.aliyun.com/zh/model-studio/qwen-audio-realtime-server-events
- https://help.aliyun.com/zh/model-studio/qwen-asr-realtime-interaction-process
- https://help.aliyun.com/zh/model-studio/qwen-asr-realtime-client-events
- https://help.aliyun.com/zh/model-studio/qwen-asr-realtime-server-events
- https://help.aliyun.com/zh/model-studio/fun-asr-realtime-websocket-api
- https://help.aliyun.com/zh/model-studio/fun-asr-client-events
- https://help.aliyun.com/zh/model-studio/fun-asr-server-events
- https://help.aliyun.com/zh/model-studio/qwen-audio-3-0-asr-flash-streaming
- https://help.aliyun.com/zh/model-studio/websocket-for-paraformer-real-time-service
- https://help.aliyun.com/zh/model-studio/paraformer-client-events
- https://help.aliyun.com/zh/model-studio/paraformer-server-events
- https://help.aliyun.com/zh/model-studio/real-time-websocket-api-1
- https://help.aliyun.com/zh/model-studio/real-time-speech-translation/
- https://help.aliyun.com/zh/model-studio/realtime-tts-user-guide
- https://help.aliyun.com/zh/model-studio/cosyvoice-websocket-api
- https://help.aliyun.com/zh/model-studio/cosyvoice-client-events
- https://help.aliyun.com/zh/model-studio/cosyvoice-server-events
- https://help.aliyun.com/zh/model-studio/non-realtime-tts-user-guide
- https://help.aliyun.com/zh/model-studio/interactive-process-of-qwen-tts-realtime-synthesis
- https://help.aliyun.com/zh/model-studio/qwen-tts-realtime-client-events
- https://help.aliyun.com/zh/model-studio/qwen-tts-realtime-server-events/
- https://help.aliyun.com/zh/model-studio/multimodal-interaction-protocol
- https://help.aliyun.com/zh/model-studio/non-realtime-speech-recognition-user-guide
- https://help.aliyun.com/zh/model-studio/qwen-asr-api-reference
- https://help.aliyun.com/zh/model-studio/voice-cloning-user-guide
- https://help.aliyun.com/zh/model-studio/qwen-omni-voice-cloning

列表中的 AOQ、HTTP/SSE、file translation、非实时 ASR/TTS 与 voice-clone
资料表示“已审计但 v1 未登记”。没有 exact profile 的调用一律返回
`model_protocol.model_not_registered`；该清单不是隐式支持或 fallback 表。
