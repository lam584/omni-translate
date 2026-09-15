# Zhipu GLM provider module

This directory owns the versioned protocol facts for Zhipu GLM. The manifest was checked against the linked official platform documentation and the official `MetaGLM/glm-realtime-sdk` repository on 2026-08-31. Every fixture is sanitized and documentation-derived: `capturedFromLive` is `false`, no credential was used, no JWT was generated, and no request or WebSocket connection was made.

## Protocol boundary

The HTTP OpenAI-compatible API and native GLM-Realtime API are separate contracts:

| Profile | Endpoint/transport | Authentication | Runtime state |
| --- | --- | --- | --- |
| `zhipu-glm.openai-chat@1` | `POST /api/paas/v4/chat/completions`, HTTP/SSE | API key as Bearer | enabled, fixture-only |
| `zhipu-glm.realtime-conversation@1` | `wss://open.bigmodel.cn/api/paas/v4/realtime`, native WebSocket/JSON | API key or derived JWT as Bearer header | disabled, not implemented |
| `zhipu-glm.realtime-translation@1` | the same native Realtime family in a translation consumer mode | API key or derived JWT as Bearer header | disabled, not implemented |
| `zhipu-glm.realtime-transcription@1` | the same native Realtime family with `transcription_session.update` | API key or derived JWT as Bearer header | disabled, not implemented |
| `zhipu-glm.asr@1` | `POST /api/paas/v4/audio/transcriptions`, multipart/SSE | API key as Bearer | disabled, not implemented |
| `zhipu-glm.tts@1` | `POST /api/paas/v4/audio/speech`, JSON/SSE | API key as Bearer | disabled, not implemented |
| `zhipu-glm.voice-clone@1` | `POST /api/paas/v4/voice/clone`, HTTP/JSON | API key as Bearer | disabled, not implemented |

The OpenAI compatibility documentation covers HTTP SDK migration and chat completions. It does not claim OpenAI Realtime compatibility. GLM-Realtime has a vendor endpoint, a vendor `session.update` body, its own event inventory and status rules, two VAD control paths, and provider-specific transcript semantics. Similar event names are not proof of protocol compatibility. Consequently, no `glm-realtime-*` model is bound to `zhipu-glm.openai-chat@1`, and every native profile remains disabled until a provider-owned adapter implements the declared contract.

## Authentication

The stored credential is one API key in `{id}.{secret}` form.

- A server can send that complete API key as `Authorization: Bearer {id}.{secret}`.
- A trusted component can split the key and derive a short-lived JWT. The JWT header contains `alg=HS256` and `sign_type=SIGN`; the payload contains `api_key=<id>`, `exp=<Unix seconds plus TTL seconds>`, and `timestamp=<Unix milliseconds>`. It is signed with HMAC-SHA256 using `<secret>`, compact-base64url encoded, then sent as `Authorization: Bearer <jwt>`.
- The official example calls its TTL variable `expireMillis`, but adds it to Unix seconds. The profile therefore records the observed unit as seconds and keeps the timestamp unit explicitly separate.
- The native endpoint takes the model inside `session.update.session.model`; there is no model query parameter.
- The AsyncAPI documentation notes that browser WebSocket APIs cannot add the required authentication header. Deriving a JWT does not remove that browser limitation; a supported SDK, native client, or trusted relay is required.

## Native Realtime lifecycle

The documented handshake is `session.created` → client `session.update` → `session.updated`. A `heartbeat` is emitted around session creation/update and then approximately every 30 seconds.

Input supports WAV or signed 16-bit mono PCM. `pcm16` means 16 kHz, `pcm24` means 24 kHz, and bare `pcm` defaults to 16 kHz. Output currently supports signed 16-bit mono PCM at 24 kHz. The guide recommends 100 ms upload chunks and documents a 50 QPS input-event limit.

`client_vad` is the default. In that mode, the client appends audio, commits the buffer, and creates a response. With `server_vad`, the server detects `input_audio_buffer.speech_started`/`speech_stopped` and creates the response. These semantics are neither Gemini's activity markers nor a promise of OpenAI Realtime behavior.

`response.done` is the universal response terminal event and is emitted regardless of final outcome. Consumers must inspect `response.status` such as `completed` or `cancelled`. A cancel path emits `response.cancelled`, may still emit type-local events such as `response.audio.done`, and then emits `response.done` with `status=cancelled`. The documentation only guarantees ordering within one event type, so consumers must not impose a total order across text, audio, transcript, and response events.

`response.audio_transcript.*` is produced by an independent transcription model. The provider states that it may differ from the model result or be empty and should not be a dependency of later events. It is advisory display text, not an authoritative translation or state-machine signal.

## Translation and transcription

Realtime translation is documented as a GLM-Realtime use case, not as a separate translation endpoint or a dedicated `translationConfig` field. The versioned translation profile therefore models a consumer mode over the native Realtime lifecycle and stays disabled until its prompt, authoritative text choice, and terminal behavior are fixture-tested by a provider-owned adapter.

Realtime input transcription is a different mode. It starts with `transcription_session.update` and completes each input item asynchronously through `conversation.item.input_audio_transcription.completed` or the corresponding failure event. It must not be confused with `response.audio_transcript.*`, which describes generated output audio.

The current Realtime guide contains a spelling discrepancy for the transcription-session acknowledgement: prose names `transcription.session.updated`, while the example payload uses `transcription_session.updated`. The fixture preserves both spellings as unresolved evidence; the adapter remains disabled instead of guessing.

Finite-file `glm-asr-2512` is yet another surface: multipart WAV/MP3 or base64 audio, at most 25 MB and 30 seconds, optionally streamed over SSE to `[DONE]`. It is not a bidirectional WebSocket transcription session.

## TTS and voice clone

Streaming `glm-tts` uses JSON/SSE and supports PCM output, encoded as base64 or hex; the documented example reports a 24 kHz sample rate and terminates with `finish_reason=stop`. Nonstreaming output may instead use WAV. `glm-tts-clone` references an already uploaded sample by `file_id`; the clone endpoint returns a reusable voice identifier and a preview file identifier. The guide recommends a short clear sample, with the reference API documenting 3–30 seconds and a 10 MB maximum. Both adapters remain disabled.

## Maturity and source precedence

The reviewed provider pages do not label these API families or models as GA, Preview, or Experimental. Their manifest maturity is therefore `unspecified`. API version `v4`, fields called beta, model pricing tiers, or a model name containing `flash`/`air` must not be converted into a product-maturity claim.

When the platform documentation and the repository's `GLM-Realtime-doc-for-llm.md` differ, this module treats the current `docs.bigmodel.cn` Realtime guide and AsyncAPI as normative. The repository document remains useful for authentication code and drift detection, but older claims such as a narrower input format or MP3 output must not override the current platform contract.

## Fixture inventory

- `openai-chat-stream.json`: HTTP text compatibility, Bearer API key, chunks, and `[DONE]`.
- `realtime-auth.json`: direct API-key presentation, JWT fields/units/signature, and the header/browser boundary.
- `realtime-session-handshake.json`: create/update/acknowledge/heartbeat ordering.
- `realtime-audio-vad.json`: audio formats and client-VAD versus server-VAD control sequences.
- `realtime-terminal.json`: completed and cancelled paths ending in `response.done`.
- `realtime-output-transcript.json`: independent, advisory output transcript semantics.
- `realtime-translation-session.json`: translation as a native Realtime consumer mode, not a compatibility-layer route.
- `realtime-transcription.json`: separate transcription setup, asynchronous finalization, and the acknowledgement spelling discrepancy.
- `asr-stream.json`: finite multipart transcription and `[DONE]`.
- `tts-stream.json`: base64 PCM deltas, returned sample rate, and `finish_reason=stop`.
- `voice-clone.json`: file-ID request and voice/preview response.

These fixtures are specification examples rather than provider observations. They cannot justify `live-verified` status.

## Official sources

The authoritative URLs and per-profile mappings live in `manifest.json`. Principal sources are the [GLM-Realtime guide](https://docs.bigmodel.cn/cn/guide/models/sound-and-video/glm-realtime), [Realtime AsyncAPI](https://docs.bigmodel.cn/cn/asyncapi/realtime), [official Realtime SDK](https://github.com/MetaGLM/glm-realtime-sdk), [OpenAI compatibility guide](https://docs.bigmodel.cn/cn/guide/develop/openai/introduction), [GLM-ASR-2512 guide](https://docs.bigmodel.cn/cn/guide/models/sound-and-video/glm-asr-2512), [GLM-TTS guide](https://docs.bigmodel.cn/cn/guide/models/sound-and-video/glm-tts), and [GLM-TTS-Clone guide](https://docs.bigmodel.cn/cn/guide/models/sound-and-video/glm-tts-clone).
