# Bailian provider module

## Authority and generated files

Edit `model-protocol-registry.json` for realtime/audio protocol authority. The original
12 dialects and 21 profiles (including every 3.5 field and source date) are preserved
verbatim as JSON values; a pinned SHA-256 regression test seals that baseline.
Edit `translation-catalog.json` for the four dedicated Qwen-MT text products. Its
strict local schema pins exact model IDs, regions, streaming semantics and sources.
These two inputs own disjoint products, not competing copies of the same authority.

Run from the repository root:

```text
node scripts/testing/build-provider-manifest-bundle.mjs
node scripts/testing/build-provider-manifest-bundle.mjs --check
npm run test:contracts
```

`build-manifest.mjs` projects these sources into `manifest.json` and the standard
`fixtures/bailian.*.json` fixtures. The generator also writes
`contracts/provider-manifests.compiled.v1.json` and the historical compatibility
path `contracts/model-protocol-profiles.v1.json`. Do not edit these generated outputs.
`fixtures/livetranslate-session-v2.json` is the new documentation-derived raw wire
fixture; the pre-existing wire fixtures remain at their original paths so the
lossless registry migration does not alter historical identities.

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
- `qwen-audio-3.1-realtime-plus`: separate manifest-only profile. Official release
  notes explicitly retain the 3.0 Plus protocol; existing Qwen Audio dialect is
  reused, never inferred from the name or conflated with Omni. Beijing/Singapore;
  no implemented adapter, so disabled in the normal projection.
- `qwen-mt-plus`, `qwen-mt-flash`, `qwen-mt-lite`, `qwen-mt-turbo`: catalog-only
  dedicated `translation_options` profiles, disabled/not-implemented. Flash/lite
  document append streaming; plus/turbo document cumulative snapshots. The
  projected fixture is non-streaming and must not imply streaming implementation.
  Model-specific sources pin regions; no wildcard or guessed dated IDs are added.

## Verification and permissions

No paid calls were made. Generated standard fixtures are documentation-derived,
`capturedFromLive: false`, and never grant network authorization. 3.8 is fixture-only.
The pre-existing 3.5 production adapter and old registry are unchanged. A historical
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
registry or obtains adapter authority. Total projection: 60 exact models and
35 profiles. Historical v1 authority and custom-binding policies are unchanged.


Legacy text presets `qwen-plus`, `qwen-max`, and `qwen-turbo` are retained as
exact IDs with exactly `text-generation` capability (`legacyPreset: true` in
the catalog source). Their presence is catalog metadata, not adapter permission.
Frontend template projection must preserve their historical visibility without
using adapter enablement as the mechanism for making metadata visible.
