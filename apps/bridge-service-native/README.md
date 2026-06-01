# Native Bridge Service

The native Windows sidecar is the production Bridge process. It owns:

- protocol `2026-06-01` control commands on `\\.\pipe\omni-bridge-ipc`
- inline translated PCM envelopes on `\\.\pipe\omni-bridge-ipc-audio`
- pre-mix source PCM envelopes on `\\.\pipe\omni-bridge-ipc-source`
- `24 kHz mono` to `48 kHz stereo f32` normalization
- gain, ducking, limiting, queue metrics, and physical speaker playback

Native Bridge opens `\\.\OmniTranslateVirtualAudio`, reads the SYSVAD-derived
render ring with `IOCTL_OMNI_BRIDGE_READ_PCM`, plays original PCM through the
selected physical speaker, and publishes `bridge.source.frame` envelopes for
desktop STT. Translated PCM is accepted only on the audio pipe and is never
written back to the source ring.
