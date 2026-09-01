# Google Gemini provider module

This directory owns the versioned protocol facts for Google Gemini. The manifest was checked against the linked Google documentation on 2026-08-31. All wire fixtures are sanitized, documentation-derived examples: `capturedFromLive` is `false`, no credential was used, and no request was sent to Google.

## Protocol boundary

Gemini exposes distinct surfaces that must remain distinct in consumers:

| Profile | Endpoint/transport | Authentication | Runtime state |
| --- | --- | --- | --- |
| `google-gemini.openai-chat@1` | `POST /v1beta/openai/chat/completions`, HTTP/SSE | API key as `Authorization: Bearer` | enabled, fixture-only |
| `google-gemini.live-agent@1` | native `BidiGenerateContent`, WebSocket/JSON | `x-goog-api-key` header or `key` query | enabled, fixture-only |
| `google-gemini.live-agent-ephemeral@1` | native `BidiGenerateContentConstrained`, WebSocket/JSON | `access_token` query or `Authorization: Token` | disabled, not implemented |
| `google-gemini.live-translation@1` | native Live API, WebSocket/JSON | Google API key | disabled, not implemented |
| `google-gemini.live-transcription@1` | native Live API, WebSocket/JSON | Google API key | disabled, not implemented |
| `google-gemini.interactions-transcription@1` | `POST /v1beta/interactions`, HTTP/JSON | Google API key or OAuth 2.0 | disabled, not implemented |
| `google-gemini.interactions-tts@1` | `POST /v1beta/interactions?alt=sse`, HTTP/SSE | Google API key or OAuth 2.0 | disabled, not implemented |

The OpenAI-compatible endpoint is a text compatibility layer. It is not a substitute for Gemini Live: Live has its own WebSocket endpoint, setup handshake, bidirectional message envelopes, PCM audio contract, VAD controls, interruption rules, and turn terminal events. No Live model is bound to the OpenAI-compatible protocol profile.

## Authentication profiles

- `google-gemini.api-key-header` maps the stored `api-key` field to `x-goog-api-key`.
- `google-gemini.api-key-query` maps the same credential to the WebSocket `key` query parameter.
- `google-gemini.openai-bearer` sends the API key with the Bearer scheme only on the OpenAI-compatible HTTP surface.
- `google-gemini.oauth2-bearer` models OAuth token acquisition plus `x-goog-user-project`. The reviewed raw Live WebSocket documentation does not establish this profile for Live, so Live does not list it.
- The ephemeral profiles require a trusted backend to call `POST /v1beta/auth_tokens` with the long-lived API key. The returned token is constrained to `BidiGenerateContentConstrained` and is sent either as `access_token` or with the `Token` scheme, not the Bearer scheme. Provisioning is deliberately disabled until implemented.

## Native Live semantics

The session starts with `setup` and becomes ready at `setupComplete`. Audio uses mono signed PCM16 little-endian: input is normally 16 kHz and model audio output is 24 kHz. The transcription guide recommends 100 ms input chunks. Depending on the configured activity handling, clients use server VAD, explicit `activityStart`/`activityEnd`, or `audioStreamEnd`.

For a normal model turn, `generationComplete` precedes `turnComplete`. For an interrupted turn, `interrupted` replaces `generationComplete`, but `turnComplete` still closes the turn. Consumers must not stop merely because an output transcript arrived.

The dedicated transcription profile has different text semantics: `interimInputTranscription.text` is a replaceable snapshot, while `inputTranscription.text` is final. Appending every interim snapshot would duplicate text.

The dedicated translation guide configures an audio-only translation model with `translationConfig`, input transcription, and output transcription. Its example nests those fields under `generationConfig`, while the general Live reference describes transcription configuration at the setup level. The fixture preserves the dedicated guide shape; the adapter stays disabled until implementation-level contract tests resolve that documentation difference. It also must not inherit the generic agent's text response modality, general system instruction, or tool configuration.

## Interactions audio surfaces

Finite audio transcription and streamed speech generation are represented separately from Live. Interactions TTS streams `interaction.created`, `step.start`, audio-bearing `step.delta`, `step.stop`, and `interaction.completed`, followed by the SSE `[DONE]` marker. The documented raw audio is mono PCM16 little-endian at 24 kHz. These profiles describe a future provider-owned adapter only; both are disabled.

## Fixture inventory

- `openai-chat-stream.json`: OpenAI-compatible text SSE, including its Bearer API-key shape and `[DONE]` terminal marker.
- `live-setup.json`: native WebSocket URL, setup/setupComplete handshake, and PCM input.
- `live-terminal-normal.json` and `live-terminal-interrupted.json`: the two mutually distinct per-turn terminal paths.
- `live-translation-setup.json`: dedicated AUDIO plus `translationConfig` setup.
- `live-transcription-interim-final.json`: replaceable interim versus committed final transcription.
- `live-ephemeral-auth.json`: backend token exchange and the two constrained-token presentation forms.
- `interactions-transcription.json`: finite audio-URI transcription over HTTP.
- `interactions-tts-stream.json`: audio delta stream and semantic/SSE terminal events.

The fixtures are specification examples, not provider observations. They therefore support only `fixture-only` verification and must never be promoted to `live-verified` without separately retained, sanitized evidence.

## Official sources

The authoritative URLs and per-profile source mappings live in `manifest.json`. The principal sources are Google's [OpenAI compatibility guide](https://ai.google.dev/gemini-api/docs/openai), [Live API guide](https://ai.google.dev/gemini-api/docs/live), [Live WebSocket guide](https://ai.google.dev/gemini-api/docs/live-guide), [Live API reference](https://ai.google.dev/api/live), [ephemeral token guide](https://ai.google.dev/gemini-api/docs/ephemeral-tokens), [Live translation guide](https://ai.google.dev/gemini-api/docs/live-translation), [Live transcription guide](https://ai.google.dev/gemini-api/docs/live-transcription), [audio transcription guide](https://ai.google.dev/gemini-api/docs/audio), and [speech generation guide](https://ai.google.dev/gemini-api/docs/speech-generation).
