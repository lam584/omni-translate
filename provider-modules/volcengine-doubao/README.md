# Volcengine / Doubao provider module

Checked against the official Volcengine pages on 2026-08-31. This module does
not treat “Volcengine speech” as one protocol. The five product families below
are deliberately incompatible.

## Protocol boundaries

| Product | Current endpoint | Framing | Terminal |
| --- | --- | --- | --- |
| Ark Responses / Chat | `https://ark.cn-beijing.volces.com/api/v3/...` | HTTPS JSON and SSE | Responses: `response.completed`; Chat: `[DONE]` |
| Seed ASR | `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async` | 4-byte nibble header, optional signed sequence, big-endian payload length | last package / negative final sequence |
| AST 2.0 | `wss://openspeech.bytedance.com/api/v4/ast/v2/translate` | naked protobuf in each WebSocket Binary frame | `SessionFinished=152` or `SessionFailed=153` |
| Realtime voice 3.0 | `wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue` | WebSocket Text JSON with Base64 audio | `session.closed`; `response.done` is only a turn boundary |
| TTS V3 | `/api/v3/tts/unidirectional/stream` or `/api/v3/tts/bidirection` | event-oriented 4-byte header plus event/session/connect fields | `SessionFinished` / `ConnectionFinished` |

The historical realtime voice binary API and TTS V1 sequence API remain
explicit deprecated profiles for migration. They are never selected from a
model-name substring.

## High-risk distinctions

- AST is not wrapped in the common-looking four-byte Volcengine envelope. The
  official demo sends `TranslateRequest.SerializeToString()` directly and
  parses each received frame as `TranslateResponse`.
- Seed ASR and TTS V3 both begin with a four-byte nibble header but the
  following fields are different. Seed ASR is sequence/payload oriented; TTS
  V3 is event oriented and may carry connect id, session id, and sequence.
- Seed ASR request `model_name` remains `bigmodel`. ASR 1.0 versus 2.0 and
  duration versus concurrent billing are selected by the explicit
  `X-Api-Resource-Id` auth/profile binding.
- The current realtime voice model uses JSON Text frames and fixed
  `session.model=1.2.6.1`. Historical model identifiers do not grant authority
  to use the legacy binary endpoint.
- Ark is a text inference family. Its Responses and Chat Completions endpoints
  are separate profiles and are not speech fallbacks.

## Documentation drift and maturity

The supplied Ark quickstart URL `1795150` is still readable and demonstrates
the Responses API, but its model example is older than the current model
catalog. The supplied model-list URL `1554711` has been superseded by the
current `1330310` catalog. Both URLs are retained for auditability.

Seed ASR product documentation explicitly describes the formal release, so the
ASR 2.0 profiles are `ga`. Current AST, realtime voice 3.0, Ark, and TTS V3
pages do not explicitly label GA, Preview, Experimental, or enterprise-only,
so they remain `unspecified`. The TTS V1 page is historical and says “not
recommended”; it is `deprecated`.

Official Seed ASR pages disagree on the complete accepted codec/rate matrix.
The first deterministic contract therefore advertises only PCM s16le, 16 kHz,
mono. AST documents additional PCM float32 24 kHz and Ogg Opus 48 kHz output;
the initial S2S profile intentionally binds only PCM s16le 16 kHz.

## Verification

The repository had no Volcengine template, runtime adapter, parser, test, or
wire fixture before this module. Every adapter is disabled and
`not-implemented`. Fixtures are synthetic, sanitized documentation artifacts;
none was captured from a live Provider and none authorizes network I/O.
