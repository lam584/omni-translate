# Native schema2 contract: self-spawn injector (2026-10-02)

Frozen minimal request; reject unknown fields. Existing exclusive OMNI_WATCH_MODE_LOCAL_AEC_PROBE_REQUEST points to request JSON; OMNI_WATCH_MODE_AEC_DIAGNOSTIC_TAP_DIRECTORY equals outputDirectory. No paid/live scenario env.

{
  "schemaVersion": 2,
  "executionId": "local-aec-<uuid>",
  "outputDirectory": "<absolute directory, basename=executionId, same as TAP>",
  "physicalDeviceId": "<real render endpoint>",
  "renderPcmPath": "<merged NEW API Chinese s16le/24000Hz/mono PCM absolute path>",
  "renderPcmSha256": "<lowercase SHA256>",
  "speechSimulation": {
    "injectorExecutable": "<absolute omni-watch-media-injector.exe>",
    "injectorExecutableSha256": "<lowercase SHA256>",
    "sourceWavPath": "<absolute original 125.815s English WAV>",
    "sourceWavSha256": "<lowercase SHA256>",
    "chunkFrames": 2400,
    "chunkIntervalMs": 100,
    "stageDurationMs": 40000,
    "deadlineMs": 180000,
    "tailStartFrame": 480000
  }
}

## Ownership and readiness

Main creates the API ledger, 6 NEW API Chinese fixtures and a single merged 24k mono s16le file; pad final source to 2400-frame alignment and provide last-section source-frame offset as tailStartFrame (2400 aligned). Main hash-pins every input/binary and launches ONLY native with existing JobObject custody. Native makes zero Provider calls, never reads saved Provider config, never does local TTS.

Native starts real production AEC3 capture and checks same endpoint/frames, then writes local-aec-ready.json (observation only, NOT launcher handshake). Native holds read-only, no-write/no-delete file handles on verified source WAV and executable and directly spawns exact injector as a child, with credential-free env and no shell/breakaway. Existing parent JobObject owns descendants. Native collects exit status/stdout receipt/stderr; native alone writes media-complete.marker after successful hash/identity/endpoint/QPC receipt validation. Main MUST NOT pre-create ready/start/complete markers or source receipt, or independently launch another injector.

Native continuously pumps NativeDesktopStream. First 2 stages each stageDurationMs real reference frames; third uses all remaining original PCM. At tailStartFrame native waits for verified injector completion, submitting explicit recorded zero-PCM deltas on SAME stream/client during the wait (separately counted physical/reference silence, not repeated Chinese). Final section then plays. At least 48000 voiced physical frames AFTER validated media completion required. No paid/live env or weaker exclusive guard.

Successful WASAPI writes are physical capacity spans, not native AEC frame boundaries. The observer accepts only nonempty finite frame-aligned 48k stereo reference writes of at most 480 frames, with original started-session, QPC, submitted/padding and prefix authority. A capacity topup (e.g. 96 frames) and short real End tail are forwarded byte-for-byte to the production capture-clock matcher. That matcher alone assembles complete 480-frame/10ms reverse input: incomplete carry is never padded or replayed, and epoch boundaries never borrow an old tail. Physical/reference evidence seals every committed frame with exact continuous ranges and hashes. This changes no acoustic, source-clock, lifecycle, budget or quality threshold.

## Outputs

- local-aec-ready.json (schemaVersion=2, executionId, physicalDeviceId, scope, readyAtMs, real capture snapshot)
- local-aec-source-media-receipt.json (actual injector stdout bytes)
- local-aec-source-media-stderr.log
- local-aec-source-media-48k-mono.f32le and its injector source-clock sidecar
- media-complete.marker (native JSON executionId/sourceMediaReceiptSha256)
- local-aec-probe-result.json (schemaVersion=2, artifactKind=watch-mode-local-aec-probe, scope=local-aec-speech-simulation, providerCalls=0, releaseEligible=false, recognitionSenderAttached=false)
- local-aec-stream-events.jsonl, local-aec-physical-48k-stereo.f32le, local-aec-linear-reference-48k-stereo.f32le; existing AEC tap/closed-loop sidecars remain

All original Chinese PCM consumed once (no truncation/replay). stageDurationMs range20000..60000,10ms-aligned; deadlineMs30000..180000 and >=original duration+10000ms; original PCM<=180s,>=3*stageDurationMs,2400-frame aligned and non-silent phase regions. tailStartFrame OPTIONAL, >=stageDurationMs*48 and >=24000 original frames remain. Enable it for final API section after125.815s English. Capture stays open until native stream padding drain AND the versioned two-second capture-quiescence proof below; activity resets, deadlines only FAIL. This is local speech simulation, NOT real translation LLM lifecycle/release acceptance. API fixture generation usage is accounted separately by main, not hidden as translation Provider calls.

## Capture quiescence receipt v2

The parent probe remains schemaVersion=2; captureDrain has its own schemaVersion=2. Old unversioned drain receipts cannot satisfy the updated local simulation contract. Native capture Start and health are scoped to the exact activation owner, not the endpoint name. The expected owner must remain current and nonterminal throughout arming, streaming and drain. Paused/stopping/removed/replaced owners, sticky faults and poisoned health cannot authorize completion.

Both completion modes require validated media completion, a naturally drained continuous output stream, no active input segment, raw and processed quiet activity, fresh successful native packet queries and consumer observations with gaps at most 100ms, and no native work in flight. At completion latestQuery must be Empty, residualBytes=0, and capturedFrames=aecCompletedFrames=dispatchCompletedFrames=the observed processed capture frame count, with earlier real capture/AEC/dispatch evidence. Empty polling never increments captured frames, packet/device clocks or AEC/dispatch counters; event signal/timeout alone is not a native query.

- completionMode=pcm-frames retains two seconds AND at least 96000 newly captured quiet frames, minimumQuietCaptureFrames=96000. It cannot bypass pending packets or partial PCM.
- completionMode=native-empty-polls requires two seconds of actual successful empty packet queries while the same capture/AEC worker remains open, minimumQuietCaptureFrames=null, and quietStartFrame=quietEndFrame. At least 21 real polls are required by the frozen 100ms maximum gap; the receipt records the actual successful query range/count. It does not claim 96000 synthetic or observed quiet PCM frames.

A raw activity generation, actual successful AEC reset, pending/unavailable query, residual queue, producer/consumer gap, segment change or state change invalidates the preceding quiet proof. Persistent progressEpoch, quiescenceEpoch and aecResetGeneration prevent a later clean snapshot from washing out an intervening discontinuity. Start alone, repeated reads of a frozen snapshot, and watchdog expiry are not success. The native wait is bounded to 20ms to permit real queries within the existing 100ms health limit; no output startup buffer, input deadline or quality threshold is enlarged.

captureDrain identifies captureOwnerId, ownerContinuity, nativeStartAcknowledged, completionMode, real quiet frame bounds, activityResets and captureStateAtDrain. nativeHealth retains successfulQueryStart/End, emptyPollCount, maximumProducerPollGapMs, maximumConsumerObservationGapMs, real captured/AEC/dispatch counters, residualBytes, workPending, terminal/fault, latestPacket/latestQuery, raw activity age/generation and reset/progress/quiescence epochs. This is operational evidence only. A successful drain must not erase an independently failed source clock, acoustic identity/completeness, echo attenuation or source preservation gate. The original 1ms source-clock gate and 180s failure watchdog remain unchanged.

## Frozen result sourceInjector object

Always present after valid PCM load, also on runtime failure: {spawnedByNative:true, spawned:boolean, processId:number|null, injectorExecutable:path, injectorExecutableSha256:hash, sourceWavPath:path, sourceWavSha256:hash, receiptPath:path, stderrPath:path, sourcePcmPath:path, startedAtMs:number|null, exitCode:number|null, receiptSha256:hash|null, receipt:actualInjectorJson|null, sourcePcmSha256:hash|null, sourcePcmBytes:number|null, cleanupError:string|null, providerCalls:0}. The root also retains sourceMediaStarted/sourceMediaComplete for lifecycle timing. On prevalidation failure sourceInjector can be absent; never synthesize a success receipt. Deadline MAX180000ms.

## Analyzer clock binding

Native seals existing injector file aec-source-playback-clock.jsonl (actual IAudioClock, schemaVersion1). sourceMediaComplete.sourceClockMetadataPath and sourceMediaComplete.sourceClockSha256 bind exact original bytes; sourceMediaComplete.sourceClockEnd contains original terminal clock record and proves clockPosition/frequency*48000 >= full original source PCM frames, submittedFrames exactly full original source span, paddingFrames=0. No wall clock used as acoustic origin; native preserves existing <=1ms drift limit and rejects missing/uncrossed clock evidence. Raw injector receipt remains unmodified and exact hash-bound. sourceMediaStart is the same native-bound executionId/physicalDeviceId/processId/startedAtMs/spawnedByNative object; sealed journal also has source-media-started.boundStart. sourceInjector supplements sourceClockMetadataPath/sourceClockMetadataSha256; no paid provider events are emitted.

Source PCM correction from injector actual implementation: mono F32LE, not s16le. sourceMediaComplete.sourcePcmFormat=f32le/sourcePcmSampleRateHz=48000/sourcePcmChannelCount=1/sourcePcmFrames. Source frame count is receipt.renderedFrames + receipt.postrollSilenceFrames (CLI default postroll0), byteCount=frames*4; clock endpoint uses this COMPLETE span. Existing sourcePCM byte hash binds the exact device-source fixture; no decoding substitutions.

Launcher compatibility: sourceMediaComplete also copies passed/endpointId/processId from the actual nested receipt (same values, NOT independent authority); sourceClock/source PCM fields remain sealed at sourceMediaComplete root.

## Failure-only capture drain observation (v1)

On a runtime/drain error or independently rejected retained source evidence, captureDrainFailureObservation is captured once after the running loop returns and before native stream abort, injector stop, or route Stop/join. It is a typed bounded scalar snapshot, not per-query disk I/O and not JSON in the measured render pump. It has artifactKind=local-aec-capture-drain-failure-observation, schemaVersion=1, diagnosticOnly=true, accepted=false, and capturedBeforeForcedCleanup=true. A failure observation is never a captureDrain receipt and its presence blocks native analysis/acceptance even if success status or a valid completion receipt is forged.

It retains expected/current activation identities, historical Start and sticky terminal/fault, actual successful query kind/count, freshness/producer gap, workPending, captured/AEC/dispatch/route counts, residualBytes and the latest real raw packet metadata. Empty/progress/quiescence/AEC-reset and raw-activity generations, raw age, consumer gap, PCM/native-idle quiet ages, last rejection branch and sticky observer error remain visible. For the same activation, expected/current health are copies of one coherent snapshot; a removed/replaced owner is explicit. Query/raw ages derive from consumer Instant sampled after health reads; observedAtMs is only snapshot custody timing, never an acoustic clock.

The snapshot also retains mediaComplete, streamDrained and the independent sourceEvidenceFailure; cleanup must not overwrite these with a stopped state or erase the source-clock rejection. Diagnostic observation cannot modify quiet, counters, completion_mode or native_receipt. Watchdog expiry remains failure. Existing 2s quiescence, 100ms freshness, 1ms source-clock consistency and acoustic thresholds are unchanged.

Coverage includes post-activation readiness/setup returned errors and panics: capture owner and optional injector/render resources stay outside the guarded initialization closure until observation. A single bounded pre-cleanup snapshot is also prepared after a successful pump so an unexpected cleanup failure cannot erase its earlier live native state; it is emitted only on failure. It never authorizes success.

sourceValidationState distinguishes accepted, rejected and not-yet-consumed at snapshot time. sourceCollectionStateBeforeCleanup distinguishes actual collector lifecycle. A collector rejection resolved only while joining cleanup is retained separately in lateSourceCollection (diagnosticOnly=true, accepted=false, exact bound evidence and evidenceFailure), and sourceEvidenceValidationPassed=false/sourceEvidenceValidationError are set. The earlier native failure snapshot is immutable; later knowledge is not backdated. I/O/child errors remain explicit cleanup failures; typed source clock rejection remains an independent source validation failure.

All setup/pump guards finish before any explicit cleanup. The single pre-cleanup native snapshot is held outside those guards; later abort or source cleanup panics cannot trigger resampling. Abort and source join have independent panic guards, so one cannot suppress the other. JoinedSource retains bound media/evidenceFailure separately from cleanup_error, including simultaneous child-stop failure and source-clock rejection. Final failure strings preserve all three runtime/abort/source-cleanup errors; diagnostic fields preserve the corresponding typed provenance.

## Real capture-tail processing receipt v1

This extends the existing local speech simulation; it is not a new media scenario,
translation Provider test, release acceptance, or a vm131 execution claim. API-generated
speech remains an immutable simulated output fixture. Acoustic thresholds and the
180/190/195-second native/Job/outer watchdogs are unchanged.

The native capture owner may have 1..959 real stereo f32 frames remaining after
normal 960-frame dequeue. It must not discard them, infer silence from the last
packet, wait indefinitely for a packet which WASAPI need not produce, or count a
stopped sender/recording-only route as open input.

Admission requires a real packet witness bound to the retained queue bytes, queue
generation, native owner, and native reset generation. Real GetNextPacketSize Empty
queries must continuously cover at least 2 seconds, with no gap over 100ms. Pending,
unavailable, failed, replayed or nonmonotonic queries revoke the permission. Any
queue/owner/reset/content mutation revokes an old permission. Event wakes and
consumer timestamps cannot substitute for native queries.

The accepted tail traverses the same production WebRTC AEC3 and capture dispatch.
A short final 10ms computational frame is padded only inside the native adapter;
only the actual input length is returned, tapped, dispatched or counted as real
capture. Even all-zero real input must call native AEC. Before any subsequent real
capture, a successful native reset is required after a padded computational frame.
This fence also survives native errors, malformed output, NaN and failed reset.
After tail AEC/dispatch, another real native packet query is required before
publishing health. No pre-processing Empty query certifies completed work.

Every new production capture tap record carries `aecProcessing` schema version 1:

- `inputFrames` equals both pre/post stereo sample counts divided by two;
- `native10msFrames` equals `ceil(inputFrames / 480)`;
- `mathPaddingFrames` equals `native10msFrames * 480 - inputFrames` and does not
  contribute to actual capture, provider or PCM evidence counts;
- `allInputProcessed` is true only after all successful native calls;
- `resetBeforeResumeRequired` records the adapter continuity fence;
- `tailAdmission` is explicitly null for regular input, or records queue generation,
  capture owner/reset domain, byte length, last real Empty query identity, poll count,
  quiet span, maximum gap, last real packet age, actual zero/nonzero sample counts
  and real frame count.

Native capture reset generation is a different domain from tap reset generation
and render continuity. Route-start can create a fixed offset; validators must not
invent equality or use render underrun to bypass a native resume reset.

Strict local acoustic acceptance requires these receipts and their correspondence
with the sealed real pre/post PCM. Legacy records remain readable as diagnostics
but cannot satisfy the new local acceptance. A padded receipt without actual tail
admission, one-Empty/frozen quiet proof, extra synthetic output, a resume without
native reset, or mismatched final processing seal blocks acceptance. Structure
verification never substitutes for the independently frozen 20dB echo attenuation,
+/-3dB source gain and >=95% source coverage tests.

Queue-head provenance is retained during idle polls and advanced only by consumed
real frames. Unknown clocks, discontinuous old prefixes and overflow are not
rehabilitated by tail dequeue. The source clock's existing 1ms bound remains hard;
additional endpoint format, raw QPC and non-Precise interrupt-time observations
are diagnostic-only and cannot authorize a source origin or a pass.

## Source injector native Initialize conformance

The source media injector uses timer-driven shared WASAPI buffering with its
unchanged two-second native scheduling reserve. Shared event-driven Initialize
requires both duration and periodicity to be zero; the former helper combined an
event flag with a two-second duration. The source helper now omits the event flag
and SetEventHandle, pacing real GetCurrentPadding/refill observations every 10ms.
The same-client render/clock services, endpoint, PCM, prefill coverage, zero-underrun
requirement, stall/absolute budgets and frozen 1ms source clock gate are unchanged.
This is a source test-tool correction, not a change to the user-selected capture
or AEC mode. Native position/time stability still requires a new frozen run; API
conformance or offline tests alone do not establish acoustic quality.

Primary API contract (not an acceptance override):
`https://learn.microsoft.com/en-us/windows/win32/api/audioclient/nf-audioclient-iaudioclient-initialize`
