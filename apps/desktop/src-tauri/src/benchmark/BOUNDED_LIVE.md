# Planned desktop benchmark slot (headless backend only)

This is an **ignored, explicitly budgeted live test**, not release evidence, a UI
acceptance test, or hardware acceptance. Do not run it as part of a test gate.
It calls the same internal production runner as `run_model_benchmark`: full
provider-draft authorization, endpoint checks, typed client plan, event parser,
progress reports, and final `BenchmarkReport`. It does not load the user storage
repository/database. Only the existing `KeyringCredentialVault` reads credentials.
No secret belongs in the config, command, stdout, or evidence.

## Dedicated temporary config

Save UTF-8 JSON to an **absolute dedicated temporary path**. Replace placeholders
with the already-approved workspace, saved credential reference, and original WAV.
Do not point this entry at an application settings/database file. The output file
must not exist; its parent directory must exist. Reusing it fails before connection.

```json
{
  "provider": {
    "templateId": "dashscope",
    "providerId": "planned-desktop-benchmark-slot",
    "kind": "dashscope",
    "templateRealtimeProtocol": "dashscope-livetranslate",
    "realtimeProtocol": "dashscope-livetranslate",
    "displayName": "Planned backend validation",
    "model": "qwen3.8-livetranslate-flash-realtime",
    "baseUrl": "wss://REPLACE_WORKSPACE.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime",
    "transport": "websocket",
    "authRef": {
      "kind": "credential-ref",
      "reference": "REPLACE_WITH_EXISTING_VAULT_REFERENCE",
      "headerName": "Authorization",
      "scheme": "bearer"
    },
    "region": "cn-beijing",
    "streamEnabled": true,
    "timeoutMs": 60000,
    "systemPromptTemplate": "",
    "responseModalities": ["text", "audio"]
  },
  "audio": "E:/ABSOLUTE/PATH/TO/ORIGINAL.wav",
  "events": "E:/ABSOLUTE/PATH/TO/NEW/desktop-benchmark.events.jsonl"
}
```

The source must be nonempty PCM16 mono 16kHz WAV. The common production runner
sends **at most the first 192,000 samples (12 seconds)** in bounded mode. Input
longer than 12 seconds is capped, not replayed. The full source SHA-256 and config
SHA-256 are recorded and rechecked in the child before vault access. The existing
production cadence is unchanged (18 ms inter-chunk interval for 20 ms PCM chunks).
This is a content-duration cap, not a claim of new real-time pacing semantics.

The config uses the existing `ProviderDraftInput` and production registry. Any
explicit unknown-model binding must pass that existing authority; this entry does
not add a model registry or endpoint exemption. Custom auth headers, inline secrets,
URL credentials/query/fragment, and inherited watch/release authority environment
are rejected. The production protocol plan still performs its own pre-connect
admission. No signed release grant or 3.5 release matrix is modified.

## Exact command for the authorized main-thread slot — NOT executed during development

From `E:/omni-translate`, in a clean PowerShell process (no watch/release diagnostic
environment):

```powershell
$env:CARGO_NET_OFFLINE = 'true'
$env:OMNI_DESKTOP_BENCHMARK_BOUNDED_CONFIG = 'E:/ABSOLUTE/PATH/TO/slot.json'
$env:OMNI_DESKTOP_BENCHMARK_BOUNDED_BUDGET = 'runs=1;audio=12s;wall=60s;no-retry'
try {
  node scripts/testing/run-with-vm3-test-environment.mjs -- cargo test --locked --offline --manifest-path apps/desktop/src-tauri/Cargo.toml benchmark::bounded_live_tests::planned_desktop_benchmark_slot -- --ignored --exact --test-threads=1
  if ($LASTEXITCODE -ne 0) { throw 'Bounded slot failed; inspect existing evidence. DO NOT RETRY.' }
} finally {
  Remove-Item Env:OMNI_DESKTOP_BENCHMARK_BOUNDED_CONFIG -ErrorAction SilentlyContinue
  Remove-Item Env:OMNI_DESKTOP_BENCHMARK_BOUNDED_BUDGET -ErrorAction SilentlyContinue
}
```

`--offline` restricts Cargo dependency resolution; it does **not** prevent this
explicit live test's WebSocket connection. The live test is ignored by default,
and even `--ignored` fails without the exact separate budget switch.

The parent reserves the output exclusively and starts one exact-test child. Only
that child reads the vault and invokes the runner, synchronously, with one connect
attempt and zero redirects/retries. At 60 seconds the supervisor **kills and reaps
the process**, covering blocking DNS/TLS/WS/vault operations; this is not cancellation
of an outer async future. A child-local watchdog is a second bound if the parent
dies. No worker reconnect path is used. Each production progress event is redacted,
appended and synced immediately. Failure/timeout keeps partial text and errors.
The parent verifies a production completed event and result before declaring success.
Child stdout/stderr are suppressed to avoid accidental secret emission.

Evidence is JSONL with `scope: headless-backend` and `nonAuthoritative: true`:
reservation, production progress events (including partial/error/completed report),
result/error, supervisor outcome. On a pre-run failure or hard timeout there may be
no final result; never treat partial text as a completed session. No audio hardware,
UI event delivery, capture, or playback is validated here.

## Offline regressions

```powershell
$env:CARGO_NET_OFFLINE = 'true'
node scripts/testing/run-with-vm3-test-environment.mjs -- cargo test --locked --offline --manifest-path apps/desktop/src-tauri/Cargo.toml benchmark:: -- --test-threads=1
```

The two ignored tests stay skipped. The ordinary supervisor regression explicitly
starts only the offline sleeping fixture child and proves kill/reap retains an
already-written partial record. Loopback fixtures keep the original authorized
request/Host/profile, replacing only transport with a private test-only loopback
socket. That transport option cannot be supplied in the live config. They do not
validate external TLS or provider behavior. Connection regressions independently
check the real tungstenite one-attempt/zero-redirect path against local listeners
and verify the production default still makes four attempts.
