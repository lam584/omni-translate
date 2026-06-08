# Diagnostics

This directory contains manual diagnostics for local support, driver
verification, provider debugging, and release triage. These scripts are not
part of the normal build pipeline unless an npm script explicitly calls them.

## Existing PowerShell checks

- `omni_diagnosis.ps1`: broad local environment and Omni runtime inspection.
- `ipc_test.ps1`: checks the desktop shell IPC surface against a built exe.
- `simple_check.ps1`: quick Credential Manager and process/log visibility check.
- `check_advapi.ps1`, `check_elevated.ps1`, `check_tauri_data.ps1`,
  `find_omni_data.ps1`: focused support probes.

## Cargo diagnostics

### `credential-write`

Verifies Windows Credential Manager write/read/delete behavior using
`CredWriteW`, `CredReadW`, and `CredDeleteW`.

```powershell
cargo run --manifest-path scripts/diagnostics/credential-write/Cargo.toml
```

Optional arguments:

```powershell
cargo run --manifest-path scripts/diagnostics/credential-write/Cargo.toml -- --target OmniTranslate:diagnostic --user diagnostic-user --secret diagnostic-secret
```

### `omni-realtime`

Runs a manual DashScope Omni realtime WebSocket diagnostic against a caller
provided 16 kHz mono PCM file. The API key must come from the environment; do
not commit keys into source files.

```powershell
$env:DASHSCOPE_API_KEY = "<your key>"
cargo run --manifest-path scripts/diagnostics/omni-realtime/Cargo.toml -- --pcm c:\path\sample_16k_mono.pcm
```

Optional arguments:

```powershell
cargo run --manifest-path scripts/diagnostics/omni-realtime/Cargo.toml -- --pcm c:\path\sample_16k_mono.pcm --manual --model qwen3.5-omni-plus-realtime-2026-03-15
```

The tool accepts raw little-endian signed 16-bit PCM at 16 kHz mono via
`--pcm`, or MP3 input via `--mp3`.

### `omni-benchmark`

Runs repeatable DashScope Omni realtime timing benchmarks.

```powershell
$env:DASHSCOPE_API_KEY = "<your key>"
cargo run --manifest-path scripts/diagnostics/omni-benchmark/Cargo.toml -- --audio c:\path\sample.wav --model qwen3.5-omni-plus-realtime --manual --json
```

Use `--audio` for format-agnostic input. Supported extensions are `.mp3`,
`.wav`, `.pcm`, `.s16le`, and `.raw`. Raw PCM-style inputs are interpreted as
16 kHz mono signed 16-bit little-endian audio. The old `--mp3` flag remains as
a compatibility alias for `--audio`.
