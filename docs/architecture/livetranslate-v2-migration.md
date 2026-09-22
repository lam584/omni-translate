# LiveTranslate 3.8 / registry migration

## Invariants

- The existing 3.5 profile, dialect, default model and release matrix identity remain unchanged.
- The September 18, 2026 real-provider four-cell results for 3.5 remain valid historical evidence for those tested builds and scenarios. They do not certify 3.8.
- 3.8 uses a separate versioned dialect: bailian-livetranslate-session-ws-v2 (version 2), profile bailian.livetranslate.3_8.realtime.ws (version 1), adapter desktop-livetranslate-session-v2.
- Output and input transcription deltas append for 3.8; 3.5 text/stash snapshots continue to replace. Dialect allowlists are not widened across generations.
- Model capability metadata does not itself grant network access. Explicit custom bindings must select an implemented profile and preserve operation, endpoint and media constraints.

## Official protocol references

Checked using public documentation during implementation (audit date 2026-09-20):

- https://help.aliyun.com/zh/model-studio/qwen3-5-livetranslate-flash-realtime
- https://help.aliyun.com/zh/model-studio/live-translator-client-events
- https://help.aliyun.com/zh/model-studio/live-translator-server-events

The minimal 3.8 configuration uses output_modalities and translation.language. This implementation explicitly selects the documented nested audio.input.turn_detection server_vad mode. Input PCM16 mono 16 kHz and output PCM16 mono 24 kHz use the documented service defaults. Manual/null configuration is not inferred from the legacy 3.5 top-level turn_detection field. Unsupported modes fail preflight.

## Validation boundary

Wire fixtures and unit tests are offline evidence only. 3.8 must not be labelled live-verified until a separately authorized bounded real-provider test succeeds. Never automatically retry paid calls. Existing 3.5 live results are not invalidated by absence of a new paid run.

## Alibaba support question (not sent)

We are integrating Bailian LiveTranslate 3.5/3.8 from Rust over WebSocket. Is there an official Rust SDK supporting these models? If not, is there a public rationale or roadmap? What is the recommended Rust integration approach, and are protocol specifications, reference implementations, and 3.5-to-3.8 compatibility notes available?

On September 21, 2026, the logged-in online-service page's Contact human action opened a routing form requiring a problem description and cloud product. The final consultation text was shown to the user and submission is awaiting action-time confirmation. No consultation message, ticket, credentials, logs or source code have been submitted. A support response is not a substitute for published protocol documentation.

## Implementation layout

- `provider-modules/bailian/` owns the catalog and versioned voice protocol definitions. Its generator emits the module manifest, strict fixtures, the shared compiled bundle, and the legacy compatibility registry. Generated compatibility JSON is not an independent editing surface.
- The 3.8 production adapter and diagnostic CLI use separate v2 branches. Benchmark results retain multiple response-local translations instead of replacing earlier VAD turns with the last response.
- Registry v2 separates instance-local advisory overrides from explicit protocol bindings. Missing fields inherit, empty arrays clear, hidden entries remain defined, and restoring a default removes its override.
- Unknown model bindings retain the real model ID. A selected enabled protocol does not permit rebinding any known catalog model, changing endpoint/media constraints, or treating fixture evidence as a successful provider call.
- Migration compares the frozen pre-upgrade seed snapshot, preserves legacy rows and uncertain fields, and is exercised with shared TypeScript/Rust vectors.

## Review and release requirements

The implementation receives independent agent review, but that does not replace the repository-required human review for core boundaries. Passing offline tests is not a release acceptance claim. Paid tests require a separately approved finite scenario/call/audio/expense budget; no such calls were authorized or executed during this implementation.

Latest integration command outputs are retained under `artifacts/tmp/livetranslate-*.log`. Some files include failed intermediate runs used to identify regressions; use each command's final result and the release gate summary rather than assuming that a log's presence proves success.

## Offline verification results

The final targeted integration run passed:

| Gate | Result |
| --- | --- |
| `verify:desktop` | lint + TypeScript + 125 test files / 1317 tests + production frontend build |
| `test:desktop-shell` | 1340 passed, 1 ignored; includes shared migration vectors and v2 API fixture deserialization |
| `test:benchmark-core` | 20 passed |
| `test:diagnostics-benchmark` | 28 passed; includes local WebSocket v2 multiple-response retention |
| `test:contracts` | 15 manifest tests; 7 manifests / 98 fixtures; generated outputs match sources |
| `test:config-paths` | 204 pointer sites / 116 config-domain sites |
| `audit:architecture` | 0 new violations; baseline not relaxed |
| `audit:dead-code` | passed; no new broad exemption |
| `coverage:gate:base` | passed; frontend branch coverage 95.03%, native bridge and shared crates pass their existing thresholds |

The Bailian directory contains 60 exact model IDs and 35 profiles. Presence in the directory does not imply an enabled adapter. The default remains `qwen3.5-livetranslate-flash-realtime`.

During the release audit, three warnings in unchanged test helpers were found. These were resolved solely by restricting test-only wrappers/imports in the echo cancellation and render-submit tracker modules to `cfg(test)`; production processing logic was not changed and the full desktop-shell tests passed afterwards.

A release-tooling teardown race was also isolated: the timeout test returned while its real log stream was still asynchronously closing, so Windows could reject fixture-directory deletion with `ENOTEMPTY`. The test now awaits that stream close only after asserting bounded timeout settlement; production behavior, the 15 ms simulated timeout, and the 1500 ms assertion are unchanged. All 28 tests in that file passed.

## Final release disposition

- The full `quality:gate:release` invocation is **not passed**. Its latest attempt stopped in Watch smoke tooling on a Windows `EPERM` atomic rename of a temporary `smoke-manifest.json`. The affected smoke test file subsequently passed 25/25 in isolation; that does not replace a successful complete gate run.
- Full gate summary: `artifacts/logs/testing/quality-gate/20260921-044919/quality-gate-auto-summary.json`. The same directory's `verify-desktop.log` records the final 1317 frontend tests; the Rust warning audit records zero warnings.
- After the separate teardown fix, `test:watch-mode-coordinator-tooling` passed 556/556. Release, quality-gate, startup and PowerShell tooling suites also passed individually.
- Final coverage evidence: `artifacts/logs/testing/coverage/20260921-050507/`.
- Required human review, release acceptance, paid 3.8 validation and support submission remain pending. No automatic provider retries, paid calls, support messages, or tickets were sent. The running desktop application was not replaced or restarted.

## Atomic publication follow-up (September 21, 2026)

The smoke checkpoint writer now reuses the existing matrix bounded rename policy through dependency-light scripts/lib/atomic-rename.mjs. Only the final filesystem publication is retried for EACCES/EBUSY/EPERM; no provider call, serialization, or cell dispatch is retried. Persistent failure preserves the old destination and fails closed. Deterministic fault injection covers failures before dispatch and after the simulated paid outcome, including exhaustion and duplicate-dispatch prevention.

Focused smoke/matrix tests passed 61/61. The full test:watch-mode-report execution passed 658 tests with 1 skipped (659 total, zero failures; completed tool session 62484). This is not a successful full release gate. Contracts and configuration-path guards were also rerun successfully; logs: artifacts/tmp/livetranslate-contracts-final-recheck.log and artifacts/tmp/livetranslate-config-paths-final-recheck.log.

## Completion-audit findings (not closed)

Independent source review identified remaining CLI parity gaps: no explicit unknown-model profile binding input, partial delta previews instead of identity-local accumulated previews, and a different v2 missing-final-text fallback from the desktop reducer. These are implementation gaps, not passing evidence; fixes and production receive-loop regressions are in progress. Existing 3.5 snapshot semantics must remain unchanged.

Credential-save invalidation now covers the current frontend's shared-reference instances and stale asynchronous results (126 frontend test files / 1322 tests passed). Backend/direct-write and persistence invalidation are still being completed; this frontend-only result does not prove the full connection-change requirement. No full release-gate success or live acceptance is claimed.

## Integration follow-up (September 21, 2026)

The three CLI gaps above are implemented and the integrated diagnostic suite now passes 45/45, including production receive-loop v1 preservation and v2 interleaved accumulation/terminal fallback. Explicit bindings use a strict profile/version/region file (or batch entry), never rewrite exact IDs, and reject known catalog IDs. Whole-manifest preflight runs before credential access or worker dispatch. Log: artifacts/tmp/livetranslate-cli-final-recheck.log.

Credential verification now uses backend session-only, non-secret-derived receipts tied to actual vault-read observations and normalized reference revisions. Application-controlled credential writes revoke receipts; repository save/load reconciles them, including headless callers. Restart intentionally revokes custom-model claims rather than pretending to detect external vault modifications. Known built-in models retain historical ready/checkedAt state and normal startup behavior. Nine backend targeted tests and 34 frontend targeted tests passed; full integrated gate remains required. Direct external vault edits within the same running session are outside this attestation guarantee.

Architecture and dead-code audits passed after placing CLI regression tests in a conventional child module and moving endpoint validation into the binding module. The frontend credential-save cleanup uses the enclosing handled try/catch/finally lifecycle; error-handling audit passes. A new complete release-gate run is in progress, logged at artifacts/tmp/livetranslate-release-final-recheck.log; do not interpret in-progress status as passed.

## Latest release-gate result (September 21, 2026, 10:42 local)

All 24 automated release-gate steps passed with no skipped-step degradation and no reused receipts: artifacts/logs/testing/quality-gate/20260921-102010/quality-gate-auto-summary.json. This includes desktop verification, desktop-shell, diagnostic/core benchmarks, contracts, configuration paths, full bridge tests, architecture/dead-code/error audits, tooling, and coverage. The earlier 94.99% frontend branch coverage failure was addressed with a behavioral regression for a never-written credential reference (no pending save, no store mutation), without lowering thresholds.

The full command still exits 1 because manual E2E, performance and install-regression evidence is pending. The summary also records the dirty/untracked worktree: artifacts/logs/testing/quality-gate/20260921-102010/quality-gate-summary.json. No manual receipt, clean provenance, reviewer approval, paid validation or support response has been fabricated. Prior failure results above remain historical troubleshooting evidence, not current automated-gate failures.

## User-relayed support response (September 21, 2026)

The user supplied a support reply stating that Bailian currently has no official Rust SDK, offers Java/Python SDKs, and recommends a Rust WebSocket client for qwen3.8-livetranslate-flash-realtime. Provenance: user-relayed response, not an independently observed agent chat transcript. No ticket number was supplied; do not invent one. This answers SDK availability and the recommended integration approach, but does not explain the absence of Rust support or provide a Rust roadmap. Do not send a duplicate consultation merely to obtain the same answer.

References supplied with the reply:
- https://help.aliyun.com/zh/model-studio/qwen3-8-livetranslate-flash-realtime
- https://help.aliyun.com/zh/model-studio/qwen3-5-livetranslate-flash-realtime#快速开始
- https://help.aliyun.com/zh/model-studio/interactive-process-of-qwen-tts-realtime-synthesis

Public-document cross-check: the 3.8 model page explicitly describes WebSocket Realtime API, session.output_modalities, response.text.delta / response.audio_transcript.delta, and differences from 3.5. The third reference is Qwen-TTS-Realtime (text-to-speech), not LiveTranslate: its input_text_buffer and Commit/ServerCommit semantics must not be imported into either LiveTranslate adapter. The existing separate v1/v2 protocol approach remains appropriate; a support reply does not replace the version-specific client/server event documentation or live validation.
## First bounded live attempt (September 21, 2026, 11:04 local)

Following the user's updated instruction to proceed without using confirmation as the blocker, one CLI session was attempted for qwen3.8-livetranslate-flash-realtime, cn-beijing, using the existing credential reference (not printed), runs=1 and a 12-second input cap. No default/provider configuration was changed. Evidence: artifacts/testing/livetranslate-bounded-20260921/attempt-01.json and cli-3.8.stderr.log. This consumes the single planned CLI attempt; no retry was performed.

The session passed session.created/session.updated handling, then failed while sending audio chunk index 81 with Windows socket error 10054 (remote connection reset). This is a FAILED attempt, not live acceptance. No completed report or provider usage receipt was obtained, so actual billed usage is unknown. The CLI source sends all input before draining receive events, which can hide an earlier server error and discard partial output on failure. Fixing this observability/lifecycle gap using local loopback tests is the next step; it does not establish why the real connection reset. Do not relabel the failure as definitely network-only or definitely a protocol rejection.

The source WAV is PCM16 mono, 24 kHz, 125.815333 seconds; SHA256 cf4990ecdc23622d12de3e62adad442755c9e84c4612787798655ee00c85fb2f. The CLI resamples to 16 kHz before applying the 12-second limit. The original file was not edited. Earlier 'no paid calls' notes above describe the state before this attempt, not the current state.

## Support receipt verified in console

Read-only inspection of the existing logged-in support page confirmed ticket ID **00047SLNMN**, product Bailian, submitted 2026-09-21 10:37, with engineer response at 10:58:27. The reply matches the user-supplied SDK/WebSocket answer above. Status at inspection: awaiting customer feedback. The agent did not submit, reply to, close or otherwise modify this ticket. SDK absence rationale/roadmap remains unanswered; no duplicate ticket is needed.

Read-only inspection also confirmed the default Beijing workspace exposes a workspace-scoped API Host. Its private exact value is retained only in local artifacts/testing/livetranslate-bounded-20260921/workspace-endpoint.json, not inserted into the provider defaults. The official 3.8 guide specifies a workspace-scoped endpoint; comparison against the first attempt's generic endpoint is a diagnostic lead, not proof of the 10054 cause.

The CLI now interleaves paced sending and receiving on one socket and protocol lifecycle, retains partial output and observed server errors on failure, and does not reconnect or advance subsequent runs after failure. Integrated CLI tests passed 51/51 (artifacts/tmp/livetranslate-duplex-cli-test.log). The previously completed full automatic gate predates these changes and is not being claimed as validation of the new duplex implementation.

## Independent reference live result

Planned attempt 02 completed successfully using the console-observed Beijing workspace endpoint, the same source's first 12 seconds converted to PCM16 mono 16 kHz, and an independent Rust port of the documented example sequence (not the application's lifecycle/parser). No retries. Evidence: artifacts/testing/livetranslate-bounded-20260921/reference-3.8.summary.json and reference-3.8.events.jsonl.

Observed: 24 input-transcription delta events, 19 translated audio-transcript delta events, 50 audio delta events, 718080 output PCM bytes (14.96 seconds at the documented 24 kHz mono PCM16), response.done and session.finished, no server error. Reported usage: input 131 tokens (audio 84, text 47), output 245 tokens (audio 187, text 58). This proves that this reference scenario/account/workspace/model produced text and audio and ended normally; it does NOT certify the application adapter, desktop benchmark or real audio-device chain. Because endpoint and client implementation both differ from attempt 01, it also does not isolate the cause of the first reset. Two of the five planned session attempts have now been used.

## Workspace preflight integration

The optional profile metadata endpointRequirements.workspaceScoped now applies only to 3.8. TS, Rust and diagnostic CLI reject generic endpoints locally for this profile; normal authorization and revalidation share the restriction. Known and explicitly bound unknown models use the same profile requirement. The UI displays a region-derived WorkspaceId URL template without changing saved addresses. 3.5 profile/dialect hash baselines and region lists remain unchanged.

After integration, desktop-shell and full frontend verification passed. A custom-binding wrong-path regression was corrected to use an otherwise-valid synthetic workspace host so it continues testing path rejection rather than being short-circuited by workspace rejection. Added UI regressions cover default-region fallback, unknown-region non-invention and address non-mutation. Coverage passed without threshold changes. Logs: artifacts/tmp/livetranslate-workspace-shell.log, livetranslate-workspace-desktop.log, livetranslate-workspace-coverage.log.

Planned application-path validation must not bypass release-evidence authorization or repurpose the fixed 3.5 release matrix. The desktop benchmark connector has an existing retry policy; a bounded diagnostic must explicitly select one attempt and preserve the normal default. A headless production-runner test is being prepared and must be labelled separately from rendered UI/device/manual acceptance. No additional paid calls were made during this integration.

## Production benchmark live results (September 21, 2026)

Planned slot03 (3.8, workspace endpoint) passed using the actual desktop benchmark runner: 12 seconds / 600 audio chunks, 20 translated text events, final translation and session.finished. Planned slot05 (3.5, original generic endpoint) was executed next while slot04's test-only evidence handling was being completed: 12 seconds / 600 chunks, 86 text events, final translation and session.finished. Both were single connection attempts with no retries and 60-second process bounds. No user saved configuration/defaults were changed. Four of five allocated sessions are consumed; only slot04 remains.

These ignored opt-in backend tests use the production authorization/session/parser/reporting paths, but not the rendered UI or hardware. Their synchronous evidence sink is unsuitable as normal-UI performance evidence. Benchmark reports do not retain output PCM; actual playback output will be assessed separately by the production worker slot. Exact evidence and preserved failed CLI attempt are indexed in artifacts/testing/livetranslate-bounded-20260921/acceptance-status.md.

Integration checks before these calls: frontend verify 1343 tests, shell1365 tests (5 ignored), CLI52, benchmark-core20, contracts, config paths, architecture/dead-code and coverage:gate:base passed. The full release gate and human/manual receipts remain distinct pending requirements.

## Realtime slot04 failure and offline harness correction

The fifth executed/last allocated session (planned slot04) failed with one initial connection, zero reconnects and zero input append attempts. No source/translated subtitle or translated PCM was received. It must remain FAILED, not a model/profile live-verification receipt. The original evidence is preserved under realtime-worker-3.8/. No additional paid calls were made.

The offline regression distinguishes consumed capture from successful Provider sends. The first real input chunk RMS (0.0000844) is below the unchanged production threshold (0.002). The former test hook acknowledged only successful appends, so the feeder waited five seconds after a legitimately skipped leading-silence block instead of advancing. Test-only consumed-byte accounting now acknowledges this normal path; sent-byte and exact PCM/hash accounting remain separate. A leading-silence mock verifies skipped samples are not fabricated into the wire ledger. Seven targeted headless tests passed (two opt-in entries ignored), including partial evidence, termination and no reconnect. This fixes the harness, not the historical live result; another successful live worker validation is still required before claiming that scenario accepted.

The final release gate attempt in artifacts/logs/testing/quality-gate/20260921-130832 stopped at watch-mode-tooling: 657 passed, one failed, one skipped. The failed Windows timebox test passed its timeout assertions but cleanup raised EPERM. It is being investigated as test-resource cleanup, without waiving the gate. Later release steps and manual/hardware/core-human-review requirements remain unfulfilled.

## Full automated quality gate passed (2026-09-21 13:59)

Directory: artifacts/logs/testing/quality-gate/20260921-133523/
- 24/24 automated steps executed and passed with zero degradation.
- watch-mode-tooling: 662 passed, 0 failed, 1 skipped.
- desktop shell: 1367 passed, 5 ignored.
- bridge service: 20 passed.
- verify:desktop, coverage:gate:base, config-paths, contracts, architecture, dead-code all passed.
- Final exit code 1 is the expected barrier for pending manual E2E/install checklists and uncommitted git state; no simulated PASS was recorded.

## Full automated quality gate rerun passed (2026-09-21 15:17)

Directory: artifacts/logs/testing/quality-gate/20260921-145329/
- 24/24 automated gate steps executed and passed with zero degradation.
- watch-mode-coordinator-tooling verified (556 passed, 0 failed, 0 skipped).
- watch-mode-tooling: 662 passed, 0 failed, 1 skipped.
- desktop-shell: 1367 passed, 5 ignored.
- bridge-service: 20 passed.
- All lint, tsc, vitest, contracts, config paths, coverage base (95.01%), dead code, and architecture boundaries passed cleanly.

## Option B: independent 3.5 / 3.8 four-worker release selection (2026-09-21)

Implementation is in progress; this section is **not a real four-worker PASS receipt**.
The preceding 24-step automatic gate receipts predate this change and do not certify it.
No additional paid call has been made during the dual-model matrix implementation.

- The default v12 3.5 plan remains unchanged. A regression pins its serialized SHA256 to `4ff47c8caf07299b60c6ba20147a5897f4b22c13a917b51663f032da679671f8`.
- An explicit 3.8 selection builds v13 `watch-mode-balanced-v13-explicit-model-endpoint`, requiring a Beijing workspace host. It selects one model and exactly four cells, never an implicit eight-cell run.
- `releaseSelection` is optional only for the legacy plan. For 3.8 it is bound to readiness, preflight grant and consumption, execution plan, cells, protocol identity, and endpoint. Node/Rust cross-language tests generate a signed Node grant and verify the Rust consumption identity/digest.
- Worker identities, routes, stagger offsets, canonical source, and the 10,100,180-sample ceiling are unchanged. A different model requires a separate execution; neither leases nor historical results are reused.
- Windows paid launch preserves the selected 3.8 workspace rather than resetting it to the generic 3.5 host. Existing saved provider URLs are not silently rewritten. Configuration mismatch must fail before connecting.
- A successful 3.8 publication uses `latest-successful-watch-mode-strict-matrix-qwen3.8-livetranslate-flash-realtime.json`. The legacy canonical 3.5 filename is preserved.

Production selection arguments (append to the existing coordinator configuration arguments):

```text
--model qwen3.8-livetranslate-flash-realtime
--endpoint-host <workspace>.cn-beijing.maas.aliyuncs.com
--region cn-beijing
```

The placeholder above is not a usable endpoint. The actual workspace value must be supplied explicitly. Signed runtime/source continuity, all four VM readiness checks, budget confirmation, real provider execution and strict raw-evidence verification remain required before claiming acceptance. Do not substitute single-machine mock results for this acceptance.

Integration notes for this option-B change:
- A read-only review caught the run-request builder's remaining 3.5-only guard; the new regression now exercises signed 3.8 leases through the actual shard request builder.
- Send-boundary validation now receives the signed release selection rather than deriving an allowed endpoint from the observed ledger.
- The managed preflight collector also validates the signed selection; merely observing a 3.8 model cannot select the v2 parser or skip wire validation.
- Shared PowerShell provider-environment helpers were extracted instead of raising existing module-size limits. The signed implementation inventory therefore has one additional file (64 instead of 63). Existing per-file upload allowances account for it; paid audio ceilings, cell deadlines and quality thresholds are not relaxed.
- A concurrent offline report-gate run had one process-custody helper timeout (670 passed / 1 failed / 1 skipped); its isolated unchanged test subsequently passed. The failed log is retained at `artifacts/tmp/dual-model-report-gate.log`; this does not count as a fully passed gate. A serial full release-gate run is being used for final verification.

## Four-worker 3.8 follow-up (September 22, 2026)

Execution `watch-shard-df9ba0e2-5637-4926-951f-4cda3690c1c6` is **not accepted**: vm171/c01 and vm169/c02 passed; vm131/c03 failed application terminal handling, and vm167/c04 failed strict content. Do not combine it with the earlier 3/4 execution or retroactively change either verdict.

- vm131 emitted an empty trailing input item with `role=assistant` and explicit `input_audio`, after `speech_started` had established the same item ID. Its empty response ended normally but the application retained the pending cue. The repair must recognize only the exact established 3.8 input lineage, reject contradictory IDs and nonempty content, and retain the previous completed cue. This does not authorize arbitrary assistant output or change 3.5 protocol semantics.
- vm167 changed September 17 to September 3 and a question about distinguishing numbers to a negative assertion. These are genuine output errors, not acceptable wording variants. A regression test retains both failures. No expected-answer corpus additions were retained for these failures.
- Offline PCM comparison found a 20ms voiced gap in vm167's broad numeric-contrast context and a 58ms voiced gap in vm131's broad date context, with the corresponding complete intervals present in physical recording. Prefilter replay exactly matches recorded Provider input; all prefilter blocks contain 960 capture frames and divide evenly for 48kHz-to-16kHz conversion. This localizes demonstrable damage to the prefilter observation point or upstream, but does not yet identify capture, queue transport, or AEC as its cause. These are not word-level alignments and do not prove which words were affected. vm167's 45-second restart silence was handled separately, not counted as lost speech.
- Evidence and numerical reproduction are retained in `artifacts/tmp/df9ba0e2-input-pcm-offline-20260922/FINDINGS.md`, `decision-numbers.json`, and `reproduce.ps1`. These diagnostic artifacts are not replacement acceptance authority.
- Strict translated-PCM postprocessing also attempted an unpinned Cargo debug build on a worker and encountered dependency-download TLS failure. The fix must use the already authorized release analyzer/hash throughout collection and final verification, fail closed if it is unavailable, and never download/build a fallback during paid execution.

No additional paid matrix was started during this investigation. Input-path damage must be investigated before another run; neither matcher relaxation nor repeated paid attempts is an acceptable substitute. Existing 3.5 acceptance evidence remains historical evidence for its original revision and scenarios, not proof that a new revision has completed live regression. Full release acceptance and required human review remain separate from offline test success.

The input-path investigation also found a deterministic Bridge lock-order defect: the source subscriber held BridgeState while waiting up to 25ms for an empty queue, but capture/dispatch needed the same state lock before enqueueing. An extracted production-path test failed at the lock-availability assertion before the repair and passed after releasing BridgeState before receive. The receiver lease and ownership checks before/after receive remain intact. This is a demonstrated scheduling defect, not yet proof that it caused every measured gap. No timeout, queue capacity, PCM content, or driver behavior was changed. Evidence: artifacts/tmp/goal-source-delivery-red.log and goal-source-delivery-green.log.

Offline follow-up: the v2 input-tail repair passed 1,413 desktop-shell tests (5 ignored), including sticky created-content and conflicting-ID counterexamples and a v1 isolation regression. The Bridge receive fix passed its four deterministic regressions and the full native Bridge suite. The fixed analyzer fixture passed all 82 strict-verifier tests, including both 3.5 and 3.8 signed coordinator paths; missing or wrong analyzer pins still fail closed. Earlier failed gate logs are retained, not relabelled as passes.

The full Watch tooling command exposed a separate test scheduling failure: the real process-custody deadline test exhausted its existing four-second deadline before the descendant's initial heartbeat, while CPU-heavy waveform checks ran in other test-file workers. The command now runs the two real-process lifecycle suites in a separate serial phase after those checks. All 23 original test files are preserved exactly once; no deadline, descendant-cleanup assertion, production timeout, or paid acceptance threshold was changed.

The integrated phased Watch report gate subsequently passed 678 tests with one existing skip (592 + 86 across the two phases), and the coordinator tooling gate passed all 626 tests. Final base coverage also passed. The earlier comprehensive release gate stopped at the then-failing Watch tooling step; it has not been relabelled as a full release pass. Required human review and a new current-revision real four-worker execution are still outstanding.
