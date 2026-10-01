# Qwen-Audio Task WebSocket adapters

Scope: exact ASR `qwen-audio-3.0-asr-flash-streaming` and
`qwen-audio-3.1-asr-flash-streaming`; exact TTS `qwen-audio-3.0-tts-plus`
and `qwen-audio-3.0-tts-flash`. No Fun-ASR, Paraformer, CosyVoice model, or
Qwen3 session dialect is enabled by these adapters.

## Integration contract

- Register `audio::bailian_tasks` and `provider::gateway_parts::task_tts`.
- ASR entry: `stt::start_stt` dispatches the actual `ProviderDraftInput.model`
  to `run_asr`; the old session worker also uses that actual model and rejects
  any non-session dialect. No hard-coded or platform-selected fallback model.
- TTS entry: `ProviderGateway::synthesize_tts` dispatches these two exact TTS
  models. The speech coordinator selects this entry for Task TTS rather than
  the existing `synthesize_realtime_audio` Omni entry.
- TTS voice argument is the actual provider voice ID. Empty/auto uses the
  documented `longanhuan_v3.6`; explicit voices are never overwritten.
  BCP-47 target languages such as `zh-CN` become documented `zh` hints.
- Register enabled profiles with adapter IDs
  `desktop-qwen-audio-task-asr-v1` / `desktop-qwen-audio-task-tts-v1` and dialects
  `bailian-qwen-audio-asr-task-ws-v1` /
  `bailian-speech-synthesizer-duplex-task-ws-v1`.
- The authorizer must request ASR `pcm` mono 16000Hz, TTS `pcm` mono 24000Hz
  (raw signed 16-bit samples). Authorization is verified before credentials/socket access.
- Each connection owns a fresh UUID and exactly one task. Connection reuse and
  implicit reconnect are intentionally not implemented: replaying uncertain
  input would duplicate or misattribute sentences.

## Invariants

`run-task -> task-started -> input -> finish-task -> task-finished`.
ASR sends PCM16 binary; TTS sends `continue-task`. Transport uses the existing
bounded connector, `/api-ws/v1/inference`, and `Authorization: Bearer`.

ASR previews replace text under `(task UUID, sentence_id)` and only
`sentence_end=true` commits. Heartbeats never open or commit sentences; enabled
heartbeat input supports long silent capture. TTS `sentence-synthesis` licenses
exactly one binary PCM frame for the current sentence. Both sentence-end and
matching task-finished are required; partial audio is not returned as success.
Unknown frames/events, task identity mismatches, duplicate/reordered sentence
identities, missing finality, provider failure, premature close, startup/terminal
or active-idle timeouts fail closed with typed errors and `role=primary-audio` / `role=speech-output`.

ASR stop drains queued input with a finite queue/deadline bound, sends
finish-task, and continues receiving final sentences through task-finished.
Stop is not cancellation and is not an immediate WebSocket close.

## Validation

`npm run test:desktop-shell -- bailian_tasks` exercises ledger/unit tests and
native localhost WebSocket worker replays; `npm run test:desktop-shell -- task_tts`
exercises gateway dispatch and the production bounded Bearer connection through
its existing loopback override. After integration run `npm run test:desktop-shell`.
No test uses a paid service endpoint.

## Official documentation (GET only, checked 2026-09-30)

- https://help.aliyun.com/zh/model-studio/qwen-audio-asr-streaming-websocket-api
- https://help.aliyun.com/zh/model-studio/qwen-audio-asr-streaming-client-events
- https://help.aliyun.com/zh/model-studio/qwen-audio-asr-streaming-server-events
- https://help.aliyun.com/zh/model-studio/qwen-audio-tts-voice-list
- https://help.aliyun.com/zh/model-studio/qwen-audio-tts-api
- https://help.aliyun.com/zh/model-studio/qwen-audio-tts-client-events
- https://help.aliyun.com/zh/model-studio/qwen-audio-tts-server-events
- https://help.aliyun.com/zh/model-studio/cosyvoice-websocket-api
- https://help.aliyun.com/zh/model-studio/cosyvoice-client-events
- https://help.aliyun.com/zh/model-studio/cosyvoice-server-events

The Qwen TTS and shared CosyVoice event pages agree on the duplex
SpeechSynthesizer sentence metadata/binary sequence. Sharing that dialect does
not authorize any CosyVoice model.
