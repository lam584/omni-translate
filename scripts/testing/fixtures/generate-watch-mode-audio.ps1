param(
  [ValidateSet("all", "general", "conversation", "technical")]
  [string]$Fixture = "all"
)

$ErrorActionPreference = "Stop"
$nodeScript = Join-Path $PSScriptRoot "generate-watch-mode-audio.mjs"

if (-not (Test-Path -LiteralPath $nodeScript -PathType Leaf)) {
  throw "Fixture generator was not found: $nodeScript"
}

& node $nodeScript --fixture $Fixture
if ($LASTEXITCODE -ne 0) {
  throw "Audio fixture generation failed with exit code $LASTEXITCODE"
}
