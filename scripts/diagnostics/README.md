# Diagnostics

This directory contains manual diagnostics for local support, driver
verification, provider debugging, and release triage. These scripts are not
part of the normal build pipeline unless an npm script explicitly calls them.

## Desktop diagnostics export bundles

The desktop Diagnostics page exports a schema-versioned directory through the
`diagnostics_v2` command. Select the smallest scope that contains the evidence
needed for the investigation:

| Scope | Contents |
| --- | --- |
| `summary` | Core runtime/diagnostics health, environment metadata, log statistics, and up to 32 KiB from the end of each available log. |
| `quick` | The same structured health data with up to 512 KiB from the end of each log. |
| `full` | Complete sanitized logs, full runtime/audio/bridge/storage/config snapshots, and any optional session evidence available to the running build. |

Every scope includes `bundle-manifest.json`, `diagnostics-report.txt`,
`diagnostics-summary.json`, `environment.json`, and `log-summary.json`. The
manifest records the actual payload file list, byte totals, truncation and
redaction counts, and collection warnings. Exports are assembled in a staging
directory and renamed into place only after the manifest and file count have
been verified.

Credential-like values routed through the desktop diagnostics logger are
redacted before they are written, and every collected log is sanitized again
when a bundle is exported. This is a safety boundary, not a guarantee that a
bundle is anonymous: log text and full snapshots can still contain conversation
text, model output, device identifiers, session ids, and local paths. Review a
bundle before sharing it outside the support context.

## Existing PowerShell checks

- `omni_diagnosis.ps1`: broad local environment and Omni runtime inspection.
- `ipc-test.mjs`: cross-platform CLI that checks the desktop shell IPC surface against a built executable. `ipc_test.ps1` remains as a Windows-compatible argument wrapper.
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
cargo run --manifest-path scripts/diagnostics/omni-realtime/Cargo.toml -- --pcm c:\path\sample_16k_mono.pcm --protocol dashscope-omni --manual --model qwen3.5-omni-plus-realtime-2026-03-15
```

The tool accepts raw little-endian signed 16-bit PCM at 16 kHz mono via
`--pcm`, or MP3 input via `--mp3`.

### `omni-benchmark`

Runs repeatable DashScope Omni realtime timing benchmarks.

```powershell
$env:DASHSCOPE_API_KEY = "<your key>"
cargo run --manifest-path scripts/diagnostics/omni-benchmark/Cargo.toml -- --audio c:\path\sample.wav --protocol dashscope-omni --model qwen3.5-omni-plus-realtime --manual --json
```

Use `--audio` for format-agnostic input. Supported extensions are `.mp3`,
`.wav`, `.pcm`, `.s16le`, and `.raw`. Raw PCM-style inputs are interpreted as
16 kHz mono signed 16-bit little-endian audio. The old `--mp3` flag remains as
a compatibility alias for `--audio`.

Benchmark JSON is local diagnostic output and can include input paths, credential
lookup names, provider errors, and raw model output. Keep `benchmark-report*.json`
files local; the repository ignores them. If documentation needs an example, use
a small hand-authored sample containing only synthetic paths, errors, and text.
