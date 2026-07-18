param(
  [string]$VoiceName = "Microsoft Zira Desktop - English (United States)",
  [int]$Rate = 0,
  [int]$Volume = 100
)

$ErrorActionPreference = "Stop"
$fixtureRoot = $PSScriptRoot
$sourcePath = Join-Path $fixtureRoot "watch-mode-en-original.txt"
$outputPath = Join-Path $fixtureRoot "watch-mode-en-original.wav"
$hashPath = Join-Path $fixtureRoot "watch-mode-en-original.sha256"

if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
  throw "Fixture source text was not found: $sourcePath"
}

$speech = New-Object -ComObject SAPI.SpVoice
$voice = @($speech.GetVoices()) | Where-Object { $_.GetDescription() -eq $VoiceName } | Select-Object -First 1
if (-not $voice) {
  $available = @($speech.GetVoices()) | ForEach-Object { $_.GetDescription() }
  throw "SAPI voice '$VoiceName' is unavailable. Available voices: $($available -join ', ')"
}

$stream = New-Object -ComObject SAPI.SpFileStream
$format = New-Object -ComObject SAPI.SpAudioFormat
$format.Type = 22 # SAFT22kHz16BitMono
$stream.Format = $format
$stream.Open($outputPath, 3, $false)

try {
  $speech.Voice = $voice
  $speech.AudioOutputStream = $stream
  $speech.Rate = $Rate
  $speech.Volume = $Volume
  $text = Get-Content -Raw -Encoding UTF8 -LiteralPath $sourcePath
  [void]$speech.Speak($text)
} finally {
  $stream.Close()
}

$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $outputPath).Hash.ToLowerInvariant()
Set-Content -Encoding ASCII -NoNewline -LiteralPath $hashPath -Value "$hash  watch-mode-en-original.wav"
Write-Host "Generated $outputPath"
Write-Host "SHA256 $hash"
