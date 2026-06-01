param(
  [string]$ConfigPath = "scripts/testing/llm-integration.config.json"
)

$ErrorActionPreference = 'Stop'
$workspaceRoot = Resolve-Path (Join-Path $PSScriptRoot "../..")
$requestedConfig = Join-Path $workspaceRoot $ConfigPath
if (-not (Test-Path -LiteralPath $requestedConfig)) {
  throw "LLM integration config not found at $requestedConfig. Copy scripts/testing/llm-integration.config.example.json to scripts/testing/llm-integration.config.json and fill in local credentials."
}
$resolvedConfig = Resolve-Path $requestedConfig
$config = Get-Content -LiteralPath $resolvedConfig.Path -Raw | ConvertFrom-Json

if ($config.environment) {
  $config.environment.PSObject.Properties | ForEach-Object {
    $value = [string]$_.Value
    if ($value -and $value -notmatch '^<.*>$') {
      [Environment]::SetEnvironmentVariable($_.Name, $value, 'Process')
    }
  }
}

$env:OMNI_LLM_TEST_CONFIG = $resolvedConfig.Path
Set-Location $workspaceRoot

cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml provider::gateway::tests::llm_integration_provider_smoke_calls_configured_models -- --nocapture
