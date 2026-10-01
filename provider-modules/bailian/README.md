# Bailian provider module

## Authority and generated files

Edit `model-protocol-registry.json` for realtime/audio protocol authority. The original
identities remain exact. The 2026-09-30 audit deliberately updates Qwen-Audio
dialogue/ASR/TTS families; a pinned SHA-256 regression test still seals every
untouched historical dialect/profile, including old Omni and LiveTranslate 3.5.
`protocol-families.json` binds enabled profiles to owner, profile version, dialect
version, adapter, operation and exact IDs. Its strict schema is
`contracts/model-protocol-families.schema.json`; it is projected to
`contracts/model-protocol-families.v1.json`, never grants wildcard authority.
Edit `translation-catalog.json` for the four dedicated Qwen-MT text products. Its
strict local schema pins exact model IDs, regions, streaming semantics and sources.
These two inputs own disjoint products, not competing copies of the same authority.

Run from the repository root:

```text
node scripts/testing/build-provider-manifest-bundle.mjs
node scripts/testing/build-provider-manifest-bundle.mjs --check
npm run test:contracts
node --test scripts/testing/model-protocol-profile-contract.test.mjs scripts/testing/model-protocol-profile-contract-family.test.mjs
```

`build-manifest.mjs` projects these sources into `manifest.json` and the standard
`fixtures/bailian.*.json` fixtures. The generator also writes
`contracts/provider-manifests.compiled.v1.json` and the historical compatibility
path `contracts/model-protocol-profiles.v1.json`. Do not edit these generated outputs.
Raw documentation payloads are in `fixtures/omni-session-v2.json`,
`fixtures/qwen-audio-session.json`, `fixtures/qwen-audio-task-asr.json`,
`fixtures/qwen-audio-task-asr-v31.json`, and `fixtures/qwen-audio-task-tts.json`.
`fixtures/family-illegal-events.json` rejects cross-family events/payloads and
unimplemented smart_turn control. Old runtime/UI fixture files are not rewritten.

The normal projection retains `kind: dashscope` and
`templateId: template-dashscope-realtime`. General reference, fixture, strict JSON
schema and generated-file checks all run; the lossless extension is not an escape
from normal validation. Exact regional/audio authorization still belongs to the
lossless registry, not the human-readable normal model availability string.

## Added products and execution status

- `qwen3.8-livetranslate-flash-realtime`: independent
  `bailian.livetranslate.3_8.realtime.ws` profile version 1,
  `bailian-livetranslate-session-ws-v2` dialect version 2,
  `desktop-livetranslate-session-v2` adapter. All three text streams use append
  deltas; terminal is client `session.finish` then server `session.finished`.
  Beijing/Singapore; checked 2026-09-20. Official default turn detection is
  `audio.input.turn_detection.type = speaker_detection`.
- `qwen3.8-omni-flash-realtime`: new `bailian.omni.3_8.realtime.ws` profile v1,
  `bailian-omni-realtime-ws-v2` dialect v2, `desktop-omni-session-v2` adapter.
  Nested `session.audio.input/output` with PCM 16k/24k and session-level
  `turn_detection`; never LiveTranslate's audio.input.turn_detection. Manual
  turns commit input then response.create; response.done drains one response,
  not a session terminal. Optional input transcription uses qwen3-asr-flash-realtime.
  Only this exact 3.8 ID is enabled, never old 3.5/legacy Omni.
- Qwen-Audio dialogue 3.0 plus/flash and 3.1 plus share
  `bailian-qwen-audio-chat-realtime-ws-v1` / `desktop-qwen-audio-session-v1`.
  Flat input_audio_format/output_audio_format are pcm (16k/24k); default voices
  are longanqian (3.0) and longanqian_v3.1 (3.1). Adapter control is server_vad
  or manual only. Ambient transcription and speech_stopped.reason=turn_invalid
  are isolated from real source/translation cues; smart_turn is not enabled.
- Qwen-Audio ASR 3.0/3.1 flash streaming share
  `bailian-qwen-audio-asr-task-ws-v1` / `desktop-qwen-audio-task-asr-v1`.
  The new 3.1 profile is `bailian.task-asr.qwen-audio-3.1.ws`. Task payloads
  use audio/asr/recognition, binary mono input and task-ID/sentence snapshots.
- Qwen-Audio TTS 3.0 plus/flash retain the exact existing profile and shared
  `bailian-speech-synthesizer-duplex-task-ws-v1` dialect, now bound only to
  `desktop-qwen-audio-task-tts-v1`. Independent Qwen payload fixtures use
  audio/tts/SpeechSynthesizer and PlainText/voice, not a CosyVoice model alias.
- `qwen-mt-plus`, `qwen-mt-flash`, `qwen-mt-lite`, `qwen-mt-turbo`: catalog-only
  dedicated `translation_options` profiles, disabled/not-implemented. Flash/lite
  document append streaming; plus/turbo document cumulative snapshots. The
  projected fixture is non-streaming and must not imply streaming implementation.
  Model-specific sources pin regions; no wildcard or guessed dated IDs are added.

## Verification and permissions

No paid calls were made. Generated standard fixtures are documentation-derived,
`capturedFromLive: false`, and never grant network authorization. All eight enabled profiles (ten exact IDs) are fixture-only in the manifest.
The pre-existing 3.5 production adapter identity/defaults are unchanged. A historical
2026-09-18 live result was reported by the coordinating task, but no confirmed
portable evidence path has yet been supplied to this module; this patch must not
claim a new live test or fabricate a historical evidence link. Preserve that
historical evidence in the integration layer until its path is confirmed.

`customProviderPolicy` remains `forbidden` pending explicit agreement with the
configuration/runtime owners. Changing this to `explicit-profile` requires their
fail-closed endpoint/operation/profile-version enforcement; catalog work alone
must not widen execution permission.

## Follow-up: text-generation discovery (2026-09-20)

The disjoint `translation-catalog.json.discoveryModels` collection records the
verified exact IDs `qwen3.8-max`, `qwen3.8-max-0902`, its documented alias
`qwen3.8-max-2026-09-02`, `qwen3.8-flash`, and `qwen-audio-3.1-tts-flash`.
The Max model page explicitly lists both snapshot spellings; no wildcard or guessed
snapshot IDs are admitted. Stable Max/Flash pages list Beijing, Singapore,
Frankfurt, Virginia, Tokyo and Hong Kong. Snapshot-specific regional availability
has not been separately established and is explicitly unknown. The 3.1 TTS page
lists Beijing; other regions are not inferred from the 3.1 dialogue model.

These discoveries project to disabled/not-implemented profiles with unresolved
endpoints and denial-only fixtures. The required generic HTTP transport envelope
is a non-executable structural placeholder, not a verified wire contract; TTS
transport/audio format/sample rate are explicitly unknown. Text entries expose
text-generation and text-translation capability metadata without assuming a
Qwen-MT translation_options contract. No discovery enters the compatibility
registry or obtains adapter authority. After the exact family extension the projection has 62 exact models and
37 profiles. Catalog discoveries and custom-binding policies remain non-authorizing.


Legacy text presets `qwen-plus`, `qwen-max`, and `qwen-turbo` are retained as
exact IDs with exactly `text-generation` capability (`legacyPreset: true` in
the catalog source). Their presence is catalog metadata, not adapter permission.
Frontend template projection must preserve their historical visibility without
using adapter enablement as the mechanism for making metadata visible.

## Official wire/policy audit (2026-09-30)

Only official documentation GETs were used after web search returned no results;
no paid inference API was called. Sources and check dates live in the registry.
Omni 3.8 requires workspace hosts in Beijing/Singapore. Qwen-Audio dialogue's
user guide lists both regions for the three exact enabled IDs. Qwen-Audio ASR
and TTS WebSocket pages list both regions and recommend workspace-domain
migration; unlike Omni 3.8 they do not state a workspace-only requirement, so
audited generic endpoints remain allowed. No US/other-region grant is inferred.

The current qwen-audio-tts-api page links independent qwen-audio-tts-* event
pages. They confirm the shared duplex task dialect but not execution authority
for CosyVoice, Sambert or 3.1 TTS. The shared dialect retains its historical
source snapshot; the exact Qwen 3.0 profile and its payload fixture pin the new
Qwen-specific sources. Dated model snapshots and all other registered families
remain manifest-only. Registry v1's envelope date/version is retained for
compatibility; only re-audited profile/dialect source dates advance to 2026-09-30.
