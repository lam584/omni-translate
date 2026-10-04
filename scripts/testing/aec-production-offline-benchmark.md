# Production linked-AEC3 offline audio benchmark v1

This Node tool prepares deterministic audio and presents **actual native worker results**. It never builds/runs a backend, calls an API, opens a sound device, or produces a release/c03 quality pass. Rust uses the existing shared dual-reference core; Node does not implement a second regression, lag search, clock fit, or post-processing filter.

## Frozen definition and original custody

Definition: `scripts/testing/fixtures/aec-production-offline-benchmark-v1.json`.

- Original English and six API-generated Chinese cues are read from the existing `local-speech-fixture-20261003-v1` directory on E:. No new E: artifacts and no API generation.
- `fixture.json`, `source.wav`, assembled `translation-stream.s16le` have explicit pinned SHA256 values in the definition. `verifyApiSpeechProvenance` additionally checks the recorded six requests, original returned PCM, assembled pause/tail, usage SHA and plan-file SHA. The plan **file** SHA `4e3664…` is distinct from the plan **payload** SHA `e5ad95…`; neither is vendor attestation.
- English PCM is **3,019,568 samples at 24k**, resampled without trimming to **6,039,136 samples at 48k**. The receipt's `125.815s` is rounded descriptive metadata, not a frame-count authority. Its last eight 24k samples are retained. Chinese has 3,312,000 original samples / 6,624,000 resampled samples, including all six cues, explicit pause and tail to 138s.
- Rate 48k, mono, 480 samples per 10ms; native duplicates each frame to 960 stereo samples. Every case spans **6,768,000 samples / 141s**, including natural source/render ends, FIR ringout and more than two seconds of quiet.
- Float32 linear 24→48 interpolation is specified in the definition; last interpolation neighbor repeats the final sample. PCM16 scale is `/32768`. Source/render gain=1, noise=0, seed=`0xaec03`. No input/output normalization. Mixed mathematical and stored peak >1 fails preparation rather than reducing overall gain.
- FIR taps `(0,.60),(336,.18),(816,-.08)`. Nonlinear phases transform raw render emission samples with the frozen c03 softclip **before** FIR/acoustic delay. Acoustic delay changes at capture sample indices; emission-phase nonlinear onset consequently travels through the known delay/FIR. Algorithm render is always the original, undelayed, untransformed Chinese (except the explicit wrong-reference control). `actualEcho` is capture/scoring reference only. Delay hint is always 0; queue age/reference lead are 0.
- Eight cases: echo-only, source-only, double-talk, dynamic-80 (0→80ms at 46s), nonlinear-160 (160ms, softclip), tail-window, c03-three-stage (0–46 / 46–92 / 92–141), wrong-reference (same real capture as double-talk; algorithm reference is Chinese shifted forward by exactly 17s cyclically within the 138s render stream). Correct raw render is separately saved for wrong-reference audit. Tail-window intentionally repeats double-talk material; it is not an additional corpus.

## Prepare: ready before native execution

From this isolated checkout:

```powershell
node --test scripts/testing/aec-production-offline-benchmark.test.mjs
node scripts/testing/aec-production-offline-benchmark.mjs --prepare
```

Default output is this C: checkout's `artifacts/testing/aec-offline-benchmark/v1/inputs`. Optional `--out` must remain below the same v1 artifact root and must not exist. `--fixture-dir`, `--synthesis-dir` can specify the same existing hash-qualified material; `--benchmark-id` can explicitly freeze a fresh UUID. No gain/threshold/oracle/backend-execution switches exist.

Preparation saves write-once `definition.json` and `generator-source.mjs` snapshots, then each lane as mono f32LE and float WAV, both hashed. `manifest.json` is the final commit marker, created only after all files finish. An interrupted preparation is incomplete; preserve it and choose a new output directory, never overwrite or delete old evidence. Later report-only source edits cannot change the already saved definition/generator/audio. Generator snapshot is custody evidence, not a standalone executable (its relative imports are not copied).

Input manifest schema:

```text
schemaVersion=1, artifactKind=production-aec-offline-benchmark-inputs
benchmarkId, definitionSha256/definitionPath, generatorSha256/generatorPath
sampleRateHz=48000, channelCount=1, frameSamples=480, sampleCount=6768000
thresholds, windowEnergyConvention=sum, provenance, seed
cases[]: id, sampleCount, files{render,source,echo,input}{absolute path,sha256,...PCM metadata}
         wavFiles, delayHintMs=0, phases, changes[numeric sample index]
         sourceEndSample=6039136, renderEndSample=6624000
         actualSourceEndSample/actualRenderEndSample (zero for disabled reference)
         segments[{name,startSample,endSample}], negativeControl
         auditFiles.correctRender (wrong-reference only)
```

Segments cover the entire capture contiguously: startup, steady, five seconds after each change, recovered, ended-English/continuing-Chinese tail, ringout, quiet. Disabled-reference cases retain the common timing anchors, with explicit enablement/actual endpoint fields. No warmup deletion.

## Native contract (main Agent runs, not this CLI)

The Rust ignored `production_aec_offline_audio_benchmark` test consumes:

- `OMNI_AEC_OFFLINE_MANIFEST`
- `OMNI_AEC_OFFLINE_OUTPUT` (new empty C: artifact directory)
- `OMNI_AEC_OFFLINE_EXPECTED_IDENTITY` (independently frozen JSON within this checkout's artifacts/testing)

Identity receipt: `{runId:UUID, inputManifestSha256, build:{sourceCommit,executableSha256,aecLibrarySha256,linkedAec3:true,shimFallbackUsed:false}}`. Native independently verifies current_exe and input manifest SHA. Source/library digests remain caller custody claims, not embedded implementation or loaded-library attestation.

Results root: schemaVersion1/artifactKind `production-aec-offline-benchmark-results`, benchmarkId/runId/build, inputManifestSha256 and manifestSha256 alias, definitionSha256, rate/channels/frame, windowEnergyConvention=`sum-of-squares`, queue age/lead=0, formalAcceptance=false.

Case field is `files`, not `inputFiles`; compare **path/sha projection**, not whole Node metadata objects. Each case has real `production` and `linked-direct` backends with roles, frame counters, full unchanged `metrics`, `windowDiagnostics`, and outputFiles `{rawMono,rawStereo,wavMono,wavStereo}`. Their paths are relative to native output root; sampleCount is per channel. Descriptors include sha256/channelCount/sampleCount/sampleRateHz/encoding. Controls bypass/silence/gain-0.1 are separately tagged native controls for official double-talk only. Wrong-reference still runs both real backends.

## Report actual results only

After the main Agent's native run, pin the results and independent identity receipt hashes:

```powershell
node scripts/testing/aec-production-offline-benchmark.mjs --report `
  --manifest artifacts/testing/aec-offline-benchmark/v1/inputs/manifest.json `
  --results artifacts/testing/aec-offline-benchmark/v1/native/benchmark-results.json `
  --results-sha256 <actual-results-sha256> `
  --expected-identity artifacts/testing/aec-offline-benchmark/v1/expected-identity.json `
  --expected-identity-sha256 <frozen-receipt-sha256>
```

Default report output is fresh `v1/report`; `--out` can select another new directory below v1. It rejects mismatched manifests/build/run/audio/gains/case timelines/thresholds/frame counters, verifies all input/output hashes and canonical containment, and checks WAV payloads equal unnormalized raw output. The presenter accepts both the generator's IEEE-float tag 3 and the actual hound 3.5.1 writer's extensible float32 GUID, validating width, rate, native channel mask, byte rate and block alignment. It rejects extensible PCM/unknown subtypes; this parsing correction never rewrites native audio. No table is created without native results. Missing native results are not a synthetic benchmark success.

Outputs: `report.json`, `report.md`, per-backend SVG curves, `listen.html`, and verified before/actual-production-after WAV copies. Player has no autoplay, volume=1, shared absolute capture-time seeking and explicit A/B controls; browser/device volume is outside the benchmark. Native WAV bytes are copied, not normalized. SVG display range clipping affects drawing only; invalid/N/A/exact-zero attenuation gaps remain gaps rather than invented 999dB values.

### Metric meanings and fixed convergence

Native energies are centered **SUM-OF-SQUARES**. Mean-square display is `sum(energy)/sum(sampleCount)`, not another multiplication by window width. Raw output RMS and raw post-minus-source error are descriptive; raw error and reported distortion ratio include echo/unexplained residual and are not pure English timbre distortion. All unexplained residual is conservatively charged to the echo upper envelope; coherent source gain remains separate.

The core thresholds stay 20dB echo attenuation, ±3dB coherent source gain, source coherent coverage ≥.95 and all existing core defaults. `sourceWindowCoverage` is the native original per-window formula; global coverage is **never** substituted. Per-segment coverage weights native `activeSourceSamples`; missing counts/coverage yield null. Source-inactive and echo-inactive fields remain N/A, invalid/core-zero-gain windows remain indeterminate. Valid exact-zero echo upper uses `echoUpperExactlyZero=true` with attenuation null, never 999/Infinity. Core quiet RMS policy is unchanged; nonzero quiet bits are not a new quality gate.

Convergence/recovery means **ten consecutive valid 100ms windows** meeting all applicable gates, active echo and (when enabled) active source. It reports completion time relative to phase start; insufficient evidence yields **null**, not zero latency. Full windows and every startup/change/tail/quiet window remain present. Windows crossing non-100ms source/ringout boundaries stay whole, are explicitly flagged, and are never interpolated or counted toward a cross-phase ten-window run. Source-only's core insufficient-echo failure is not rewritten, and is not an English-preservation failure. Wrong-reference/control observed false positives are reported honestly, not forced to fail. `overallPassed`, qualityAcceptance and releaseEligible remain false: this benchmark is not live/c03 acceptance.

The input/native/report artifacts together are expected to stay below roughly 6GB with the official controls. All new actual audio/artifacts stay on C:; existing E: custody is read-only. No cleanup of historical evidence.


## Opt-in APM diagnostic point evidence

The original manifest/results remain immutable. To investigate an already-frozen run, create a **new** manifest beside the original containing the same cases/PCM descriptors/definition/provenance plus `diagnosticApmStats: true`. This is not a new audio definition or an oracle-delay run. Give the new manifest its own SHA256, run identity, source/executable/library freeze and write-once output directory. Do not rebuild during execution. The runner defaults this flag to false; old results lacking it cannot satisfy an opt-in request or be retrofitted with synthetic telemetry.

The real production backend copies its existing cached native statistics; it adds no native query. Linked-direct uses the existing public getter after every ten 10ms frames, plus the final short complete-frame tail. Read errors/stale counters never discard PCM, reset the algorithm or terminate streaming. Compare **all actual output hashes** to the previous no-telemetry run before interpreting a diagnostic run; a DSP difference must be investigated, not hidden.

Each backend's optional `apmTelemetry` has version 1 and cadenceSamples=4800. Snapshots cover [startSample,endSample) contiguously; the value is a **point observation after the last frame**, not an average of that interval. Its authority is capture-input sample ordinal, **not** output alignment/latency, QPC or physical clock. Backend sources are production-cached-native-stats and linked-direct-public-stats. Exact expected/observed frame counters establish **getter-counter freshness only**, not signal payload age. The APM reporter has a capacity-one/drop-new queue, so a less frequent reader can retrieve an earlier metric epoch. The three exported fields are not the header's first-read/one-second delay-median statistics. Required signalSampleAuthority=public-statistics-payload-has-no-origin-sample-ordinal and freshnessMeaning=getter-counters-match-processed-frames-not-signal-payload-age prevent callers from treating queued signals as proven current-frame metrics. Optional signals are erleDb, residualEchoLikelihood and reportedDelayMs; null is unknown, never zero. Stale/error signals stay null, while counters/read-failure/error witnesses remain visible. Negative controls cannot carry real-backend APM evidence.

The presenter saves complete per-backend APM JSON, CSV and point SVG files beside the existing external quality curves. ERLE is an **internal statistic**, not the dual-reference external attenuation target. Residual likelihood is not residual PCM energy. Reported delay is not a proven instantaneous acoustic delay or 1ms acceptance clock. Sparse/missing/stale statistics are recorded honestly and cannot change audio quality, convergence or live c03 gates.

Deterministic counterexamples cover disabled/legacy scope, missing evidence, wrong source/domain/cadence/counters, reordering/gaps/lost tail, stale signal leakage, unmarked read errors, fabricated control statistics and unknown/nonfinite values. Quality presentation remains identical with or without telemetry fields.
