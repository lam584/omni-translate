# OpenAI provider module

This module records the OpenAI contracts relevant to Watch Mode. It is based
only on official OpenAI documentation checked on 2026-08-31. Fixtures are
sanitized contract examples assembled from the documented wire shapes; they
are not retained production traffic and contain no usable credentials or
audio.

## Connection authority

- `openai.realtime.conversation.websocket.ga@1` is enabled with
  `fixture-only` verification. It uses the GA nested session shape, bearer
  header authentication, 24 kHz mono PCM16 input, and explicit inspection of
  `response.done.response.status`.
- `openai.realtime.translation.websocket.current@1` is disabled. The current
  runtime sends fields that the translation session does not accept and marks
  the session ready before `session.created` / `session.updated`.
- Both OpenAI realtime-transcription profiles are disabled. Official model
  pages advertise `v1/realtime/transcription_sessions`, but the current guide
  does not establish a WebSocket connection URL. The API family therefore has
  `endpointStatus: unresolved`, a null endpoint template, and must fail before
  network I/O. The Azure `?intent=transcription` URL is not inherited here.
- WebRTC and Audio API profiles describe official contracts but remain
  `not-implemented` in the desktop runtime.

Model names never select a dialect. Every model operation binds to an exact
profile id and version. `gpt-realtime-whisper` has a separate manual-only
profile because the model does not support server VAD.

## Terminal behavior

`response.done` ends a single Realtime Response, not necessarily a successful
turn. Callers must distinguish `completed`, `cancelled`, `failed`, and
`incomplete`. A translation session closes only after the client sends
`session.close` and receives `session.closed`; recoverable `error` events do
not imply closure.

## Official sources

- https://developers.openai.com/api/docs/guides/realtime
- https://developers.openai.com/api/docs/guides/realtime-websocket
- https://developers.openai.com/api/docs/guides/realtime-webrtc
- https://developers.openai.com/api/docs/guides/realtime-translation
- https://developers.openai.com/api/docs/guides/realtime-transcription
- https://developers.openai.com/api/docs/guides/speech-to-text
- https://developers.openai.com/api/docs/guides/text-to-speech
- https://developers.openai.com/api/docs/models
