param(
  [ValidateSet("optional", "all", "general", "conversation", "technical")]
  [string]$Fixture = "optional",
  [switch]$ConfirmCanonicalOverwrite
)

$ErrorActionPreference = "Stop"
$nodeScript = Join-Path $PSScriptRoot "generate-watch-mode-audio.mjs"

if (-not (Test-Path -LiteralPath $nodeScript -PathType Leaf)) {
  throw "Fixture generator was not found: $nodeScript"
}

$nodeArguments = @($nodeScript, "--fixture", $Fixture)
if ($ConfirmCanonicalOverwrite) {
  $nodeArguments += "--confirm-canonical-overwrite"
}

& node @nodeArguments
if ($LASTEXITCODE -ne 0) {
  throw "Audio fixture generation failed with exit code $LASTEXITCODE"
}
