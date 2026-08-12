# Native Bridge Service

The native Windows sidecar is the production Bridge process. It owns:

- protocol `2026-08-13-audio-routing-v7` control commands on `\\.\pipe\omni-bridge-ipc`
- inline translated PCM envelopes on `\\.\pipe\omni-bridge-ipc-audio`
- pre-mix source PCM envelopes on `\\.\pipe\omni-bridge-ipc-source`
- `24 kHz mono` to `48 kHz stereo f32` normalization
- gain, ducking, limiting, queue metrics, and physical speaker playback

The `sourceCaptureMode` selected during `bridge.init` owns one source backend:

- `virtual-driver` reads the SYSVAD render ring from
  `\\.\OmniTranslateVirtualAudio` and may monitor the original audio.
- `process-exclusion` uses WASAPI application loopback with the Bridge process
  tree excluded. Original audio is never monitored by Bridge in this mode;
  translated PCM remains enabled on the dedicated translation player.
- `none` keeps the Bridge and translation pipe available without source capture.

Process exclusion requires Windows build 20348 or newer. Unsupported or failed
activation is returned as a typed Bridge error and never falls back to another
capture backend. Translated PCM is accepted only on the audio pipe and is never
written into a source stream.

Every translated-audio frame names both `translationSink` and
`routeDirection`. Only `physical-playback` + `inbound` can enter the Bridge
physical playback queue. `virtual-mic` + `outbound` is accepted only when
`bridge.init` explicitly requests virtual-microphone output and the driver
reports the selectable `Omni Translate Virtual Microphone` endpoint, ABI
`0x20260810`, and canonical `48000Hz/mono/pcm16` format. Bridge downmixes its
final 48 kHz stereo samples to PCM16, keeps one persistent driver handle and
generation per desktop session, and writes paced v6 chunks through the driver
session ABI. It never substitutes physical playback for an outbound write.

Each outbound v6 frame carries `cueId`, `chunkIndex`, and `chunkCount`. Bridge
uses them to make retry writes idempotent and emits `queued`, `started`, and one
terminal `completed` or `route-failed` status for the cue. Driver/session/write
failures stop claiming success and return the corresponding
`bridge.virtual-mic-*` NACK. Runtime state exposes capability, endpoint, format,
generation, buffered/consumed/dropped/underrun/rejected counters, and active
session state. Reconfiguration and shutdown end the owner session; closing a
crashed Bridge handle is the kernel fallback.

`bridge.process-loopback.probe` is a proactive capability check that is valid
before `bridge.init`. It briefly activates an application-loopback audio client
for the Bridge process, reports `probing` followed by `ready`, `unsupported`, or
`failed`, and immediately releases the client. The command does not start a
source worker, open a long-running capture stream, or inspect the virtual driver.

`monitorPlaybackEnabled` controls only source monitoring;
`translationPlaybackEnabled` controls the dedicated translation player. Process
exclusion always keeps that translation player available so Bridge-owned output
stays inside the excluded process tree; `mixControl.translatedAudioEnabled` may
still intentionally mute translated audio.

Translation cues wait in a dedicated bounded queue instead of the source/control
channel. Projected start time includes the active cue plus pending cue durations.
Pending cues that have already missed their own five-second start budget are
evicted; otherwise a fresh cue is explicitly rejected when capacity or its
projected-start budget would be exceeded. The active cue is never interrupted.
Queue lifecycle is logged as `queued`, `started`, `completed`, `stale-dropped`,
or `route-failed` with the cue id.

Every lifecycle event also carries a stable `statusId`. The source-pipe client
applies the event idempotently and returns a framed
`bridge.translation.status.ack`. Bridge removes the FIFO outbox entry only
after the matching acknowledgement; a disconnect after a successful pipe write
therefore replays the same event on the next connection. All pending terminal
events are acknowledged before a following `bridge.source.error` is emitted.

## Virtual microphone target-capture evidence

`omni-virtual-mic-target-capture.exe` is the installed-route acceptance client.
It starts an isolated copy of the installed Bridge, opens the authoritative
capture endpoint in a separate WASAPI process, routes one v6 outbound cue, and
generates `virtual-mic-capture.wav`, `virtual-mic-capture-probe.json`, and
`runtime-snapshot.json`. The snapshot derives per-cue virtual-microphone and
physical-playback frames from Bridge state-query deltas and derives the cue
lifecycle from acknowledged `bridge.translation.status` events. The command has
no synthetic fallback or skip result.
