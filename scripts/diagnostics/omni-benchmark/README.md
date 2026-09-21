# Standalone LiveTranslate benchmark

The default remains `qwen3.5-livetranslate-flash-realtime` with the v1 snapshot protocol.
Built-in 3.8 selects the v2 incremental protocol by its exact compiled profile.
Unknown model IDs fail closed unless explicitly bound. No model-name heuristics are used.

## Explicit unknown-model binding

Single mode accepts `--protocol-binding <file>`. The UTF-8 JSON file contains exactly:

```json
{
  "profileId": "bailian.livetranslate.3_8.realtime.ws",
  "profileVersion": 1,
  "region": "cn-beijing"
}
```

See `protocol-binding.schema.json`. The parser rejects missing fields, unknown fields,
wrong types and duplicate fields; authorization validates the values against the compiled
registry. The only implemented bindings are the v1 profile
`bailian.livetranslate.realtime.ws` and the v2 profile above (both profile version 1).
The declared region must match both the selected profile and the endpoint host family.
The existing v1 endpoint restrictions are retained; workspace hosts are supported only by v2.

Example invocation (performs a real provider call; **not** an offline test):

```powershell
omni-benchmark --audio sample.wav --model my-deployment --protocol dashscope-livetranslate --protocol-binding binding.json --base-url wss://dashscope.aliyuncs.com/api-ws/v1/realtime
```

Every known model ID in **all providers** of the compiled catalog, and every exact model ID
in the protocol registry, is forbidden from explicit rebinding (even to its existing profile).
The real unknown ID is retained in the query, handshake and report. Query encoding prevents
an ID from injecting parameters; no catalog entry or `exactModelIds` array is rewritten.
Operation remains native translation; client/server event allowlists, media framing,
profile version, enabled adapter, endpoint path and terminal lifecycle remain authoritative.
Binding on other protocols or manual audio mode is rejected.

## Batch mode

Each existing manifest entry may include optional `protocolBinding` containing the same
object as the single-mode file. All existing manifest fields remain unchanged. Omit it for
built-in models. There is deliberately no batch-global binding override.

The entire manifest is preflighted before audio decoding, credential access or worker launch.
A bad later entry aborts the batch, rather than allowing earlier entries to make paid calls.
Each LiveTranslate entry must use `audioMode: "server_vad"` and its complete client plan is
validated before execution; each worker repeats preflight defensively.

## v2 receive semantics

ASR previews accumulate by item/content identity. Translation previews and terminal fallback
are bound to stream/response/item/output/content identity. Reports store normalized previews
in `stash`, while output `raw_text` preserves the raw delta. A v2 text/transcript done event
may omit its final field only when a matching snapshot exists; null, wrong types and unmatched
identities still fail. Terminal response output must still agree with the committed text.
Completed VAD response translations remain separate and are joined in the final report.
The v1 replacement and terminal-field requirements are unchanged.

## Offline regression commands

```powershell
$env:CARGO_NET_OFFLINE = 'true'
npm run test:diagnostics-benchmark
npm run test:benchmark-core
```

Run these from the repository root. Production receive-loop tests use local loopback sockets;
they do not contact providers, read real credentials or certify paid/live 3.8 behavior.

## Full-duplex diagnostics and failed-run output

After the existing handshake, LiveTranslate uses one nonblocking WebSocket (including
its existing TLS session), one lifecycle ledger and one inbound-event consumer for both
audio transmission and terminal draining. The 320-sample/16 kHz audio frames are scheduled
at 20 ms intervals; receive polling uses a 1 ms idle sleep, not the shared blocking read
timeout. Write backpressure flushes the already-buffered frame without sending that
application message again. No reconnect, provider retry or secondary TLS socket is used.

Validated VAD/output events may arrive while audio is still being sent. The same identity,
payload and generation checks apply in both phases. session.finished is still rejected
until session.finish has actually been flushed and the existing ledger is fully drained.

In single-model --json mode, an attempt failure writes and flushes an
omni-benchmark-failure/v1 document to stdout before exiting nonzero. It contains status=failed,
the original failure, any completed earlier runs, and diagnostic.exchange with:

- partial: accepted ASR, translation previews/committed text and response timestamps/counts;
- wire: the received server error event, observed close code/reason, event count and terminal flag;
- audio_chunks_sent, pending_audio_chunk, session_finish_sent and elapsed/send timings;
- transport_error, when observed separately from the provider error.

Non-JSON mode writes that diagnostic to stderr. Batch results retain the same diagnostic
on the failed entry with report=null; incomplete output never becomes a success sample.
Failed single-model attempts stop the invocation, even if --runs requested more runs.
No credential or outbound audio payload is included by the diagnostic collector.
The provider's received error body is preserved verbatim; review it before sharing.

Failure-tail collection only consumes a bounded number of immediately available frames.
An abrupt TCP reset can still leave no readable server error; absent evidence stays absent,
and this change does not identify the cause of any real-provider reset.

The local timing regression tests both generations with a deliberately configured 100 ms
blocking timeout and checks 16 frames: average interval 17–40 ms, maximum interval below
95 ms and send duration below 650 ms. It also checks exact frame contents/order, receives
translation before finish, and requires one valid terminal lifecycle. These tests use
loopback only and do not authorize a real-provider rerun.
