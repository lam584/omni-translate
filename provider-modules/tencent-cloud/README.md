# Tencent Cloud provider module

Checked against the official Tencent Cloud pages on 2026-08-31. This module
keeps product contracts separate even when they reuse the same Tencent CAM
credential pair.

## Protocol boundaries

| Profile | Endpoint | Wire contract | Status |
| --- | --- | --- | --- |
| `tencent-cloud.speech-translate.ws-v1@1` | `wss://asr.cloud.tencent.com/asr/speech_translate/{appid}` | Text JSON plus naked Binary audio, HMAC-SHA1 query | Existing adapter, fixture-only |
| `tencent-cloud.asr.ws-v2@1` | `wss://asr.cloud.tencent.com/asr/v2/{appid}` | Text JSON plus naked Binary audio, distinct HMAC-SHA1 canonical path | Not implemented |
| `tencent-cloud.sts.ws-v1.simul@1` | `wss://mps.cloud.tencent.com/sts/v1/{appid}` | STS Handshake/AsrResult/LLMResult/ProcessEof plus naked Binary audio | Not implemented |
| `tencent-cloud.sts.ws-v1.llm@1` | same | Same client wire, `mode=llm`; custom LLM is a server-side callback | Not implemented |
| `tencent-cloud.tts.stream-ws-v1@1` | `wss://tts.cloud.tencent.com/stream_ws` | Query-only request, naked Binary audio plus Text JSON | Not implemented |
| `tencent-cloud.tts.stream-wsv2-v1@1` | `wss://tts.cloud.tencent.com/stream_wsv2` | Text JSON actions, naked Binary audio plus Text JSON | Not implemented |
| `tencent-cloud.tts.text-to-voice-2019-08-23@1` | `https://tts.tencentcloudapi.com/` | TC3-signed JSON request, JSON/Base64 audio response | Not implemented |
| `tencent-cloud.tts.long-text-2019-08-23@1` | same | TC3-signed asynchronous task creation | Not implemented |

Classic `speech_translate` and MPS STS are not versions of one protocol. They
have different hosts, signing algorithms, request parameters, handshakes,
events, delta semantics, output audio, and terminal conditions.

## Important lifecycle rules

- Classic translation hypotheses replace the current sentence. They are not
  append-only deltas. `sentence_end` commits one sentence; `final=1` ends the
  text stream, while optional TTS requires `final=2` for complete termination.
- STS requires the first `Handshake` to have `Code=0`. ASR text is a
  replaceable snapshot, LLM text is append-only, and only `ProcessEof` is the
  full session terminal. A zero-length Binary frame is an engine-dependent TTS
  sentence marker.
- TTS WebSocket V1 sends its text in the signed Upgrade URL and has no
  application-layer client frame. V2 waits for `ready=1`, accepts
  `ACTION_SYNTHESIS`, and ends after `ACTION_COMPLETE` followed by `final=1`.
- `CreateTtsTask` success means accepted, not synthesized. A result-query
  profile is required before the long-text path can claim audio completion.

## Verification and remaining unknowns

No fixture was captured from a real provider and no profile is live-verified.
All fixture values are synthetic or copied as redacted structural examples
from official documentation. The existing classic adapter is therefore only
`fixture-only`; every other adapter fails closed as `not-implemented`.

The STS page lists only PCM/MP3/WAV in one parameter table but lists additional
FLAC/Opus/u-law/a-law output in its audio section. A future adapter must trust
the negotiated `HandshakeResult`, not a static cross-product. The official
pages do not label classic translation, STS, or TTS as GA, Preview,
Experimental, or enterprise-only, so their maturity remains `unspecified`.
