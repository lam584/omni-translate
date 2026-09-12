# Zero-Provider audio probes

These opt-in diagnostics distinguish routing/capture/AEC faults without opening
a translation or Judge session. They do **not** authorize c02, c03, Strict Content,
full coverage, a restart/tail check, or release success.

## Runtime selection and safety

- Check measured C/E free space against the 3 GiB floor before either probe
  starts. A low/unreadable volume records failure; it does not trigger an
  implicit cleanup, a build, or a Provider attempt.
- Use a newly prepared, signed runtime and its explicitly pinned **local-isolation
  distribution** digest. A production runtime directory is a different layout;
  do not fabricate a `runtime-distribution.json` for it.
- The isolation distributor freezes the probe entry points, their imported Node
  modules, PowerShell modules, canonical media and device helper alongside the
  15 runtime files. All selected bytes are revalidated before launch.
- The AEC launcher additionally checks the compiled local-probe capability in
  the hash-pinned Desktop **without executing it**. An older Desktop may ignore
  the new environment switch and preconnect a saved Provider during normal
  startup; it must be rejected before launching. The capability marker is a
  version guard, not a substitute for a trusted signed distribution digest.
- Use exact endpoint IDs. Neither probe may substitute the default endpoint.
- The native job owns the process before its first instruction, owns descendants,
  and requires exit/output drain within an absolute deadline. Do not recover
  ownership by guessing a PID or by killing every process with a matching name.
- A timeout, incomplete cleanup or inconsistent evidence is a failed diagnostic;
  there is no automatic retry. The AEC runner distinguishes `not-launched`,
  `unknown`, `unverified-producer-report` and `supported-probe-reported-zero`.
  A missing, malformed or foreign-execution count cannot establish zero;
  nonzero accounting survives a launcher failure after the producer commits.

## Pure-echo AEC component diagnostic

The Desktop opt-in uses the production `AudioRouteSupervisor`, native speaker
render callbacks and AEC implementation, with no recognition sender. The local
audio operation does not load saved Provider configuration. Normal Watch/release
diagnostics are excluded. Presence of the opt-in, including an empty or malformed
request, also blocks shared native audio preconnect, recognized-route start,
capture prewarm, speech dispatch and translation-start entry points before their
Provider-capable work. This does not depend on a successful frontend IPC ping.
The input is hash-bound s16le, 16 kHz mono PCM of at most 180 seconds. An explicit
one-second silence preamble is part of the stimulus, not evidence of readiness
or convergence.

Example with values obtained from the new distribution and worker inventory:

```powershell
node "$runtime\scripts\testing\run-watch-mode-local-aec-probe.mjs" `
  --runtime-root "$runtime" --distribution-digest "$distributionDigest" `
  --output-parent "$diagnosticOutputParent" --render-pcm "$sourcePcm" `
  --physical-device-id "$physicalEndpoint" --timeout-seconds 300
```

The output parent must already exist. Every invocation creates a fresh UUID
directory. The default helper workspace is the verified runtime itself; an
explicit workspace override must contain exactly the pinned process-custody
helper bytes.

Artifacts include the request, selected runtime, launcher logs/custody result,
producer report, final runner result, and:

- `aec-render-reference-48k-stereo.f32le`
- `aec-pre-capture-48k-stereo.f32le`
- `aec-post-output-48k-stereo.f32le`
- `aec-frame-metadata.jsonl`
- `aec-terminal.json`

The schema-v2 terminal is committed only after admission is closed, native work
is fenced, and the writer finishes its bounded drain. Missing/torn events, drops,
I/O errors, pending buffered data, hash/count disagreement or an uncommitted
terminal cannot pass integrity verification. Sequence/reset ownership, PCM spans,
the final operation counts and requested/effective endpoints are reconciled.
Invalid packet clocks are kept explicitly invalid; they and recoverable resets
remain diagnostic observations, not automatically failed audio-health verdicts.

`status: completed` means the diagnostic operation and evidence capture completed.
`audioHealth: not-evaluated` and `releaseEligible: false` remain explicit. This is
pure-echo evidence, **not** the c03 double-talk/content scenario. Analyze raw
capture versus post-AEC audio before deciding what production behavior to change.

## c02 physical-source diagnostic

`watch-mode-physical-source-probe.mjs` uses the canonical media through the real
virtual-driver injection → bridge keep-original-audio → explicit physical output
→ WASAPI capture route. Direct speaker playback is not an equivalent substitute.
It uses the production −5 dB injection and three-second postroll, with a bounded
136-second diagnostic recording and no fabricated Desktop session terminal.

Required selections are `--workspace-root`, `--runtime-manifest`,
`--distribution-digest`, `--output-parent`, `--virtual-render-endpoint-id` and
`--physical-playback-device-id`. The workspace is the verified isolation runtime.
The optional `--media` can only select the same canonical fixed media. Its
waveform analysis must use the pinned release analyzer, never silently build a
debug tool or fall back to another checkout. Capture and analysis share the same
absolute deadline: finishing capture does not grant the analyzer a fresh budget.
An expired deadline or unsupported analyzer response fails without retry/build.

The 24.010-second signed reference segment is exposed separately for diagnosis.
A waveform finding does not become a translation/content or release verdict.

## Accounting and review boundaries

- Probe-mode guards cover shared audio-start/preconnect, Provider gateway,
  Provider-management Probe/Smoke/model-list and direct benchmark entry paths,
  including enqueue-time and execution-time checks. This is an application
  contract, not a network firewall; newly added outbound entry points must use
  the same guard and remain subject to review.
- Physical-source failure handling independently recovers custody, cleanup and
  route receipts with bounded, strict UTF-8 reads. Nonzero observations remain
  visible with their source; duplicate reports are not summed, conflicting
  counts are unknown, and later zero cannot erase earlier nonzero. Missing,
  truncated, malformed or oversized receipts are not repaired into a zero.
- `not-launched` and `validated-receipts-reported-zero` distinguish prelaunch
  zero from completed, validated producer receipts. Failure observations may be
  `unverified-producer-report`, `conflicting-producer-reports` or `unknown`.
  These provenance labels do not grant a content, audio-health or release pass.
- Real hardware probe evidence and the new signed distribution remain required.
  Offline counterexamples cannot replace the benchmark-core manual review or
  the full required-validation/release gates.

## Fast validation

```powershell
node --test scripts/testing/run-watch-mode-local-aec-probe.test.mjs
node --test scripts/testing/watch-mode-physical-source-probe.test.mjs
npm run test:watch-mode-report
npm run test:powershell-tooling
npm run test:contracts
```

The focused process-integration fixtures launch non-audio stand-ins, not a
Desktop/Provider session. Hardware behavior still requires the explicitly
selected fresh runtime and worker devices. Do not relabel retained r60/r61/r71
failures or an incomplete r72 build as passing evidence.

`test:watch-mode-report` also includes older canonical-waveform integration tests
whose default analyzer path invokes `cargo build`. It is not a build-free command
just because the two probes use no-build paths. When builds are forbidden, record
the blocked integration results rather than claiming this entire gate passed.
Rust validation (`npm run test:desktop-shell`) is a separate authorized gate; reuse
the main workflow's recorded result when a repeat Cargo run is not permitted.
