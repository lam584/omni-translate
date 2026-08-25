#requires -Version 5.1

function Invoke-WatchModeLogParser {
  param(
    [Parameter(Mandatory = $true)][string]$Operation,
    [Parameter(Mandatory = $true)][string]$AppLogPath,
    [string]$RunMarker
  )
  $workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../..'))
  $parserPath = Join-Path $workspaceRoot 'scripts/testing/watch-mode/log-parser-cli.mjs'
  $arguments = @($parserPath, '--operation', $Operation, '--input', $AppLogPath)
  if ($RunMarker) { $arguments += @('--marker', $RunMarker) }
  $output = @(& node @arguments 2>&1 | ForEach-Object { "$_" })
  if ($LASTEXITCODE -ne 0) {
    throw "Watch Mode log parser failed ($Operation): $($output -join ' ')"
  }
  return (($output -join "`n") | ConvertFrom-Json).value
}

function Get-LogTextAfterMarker {
  param([string]$Path, [string]$RunMarker)
  return [string](Invoke-WatchModeLogParser -Operation 'text-after-marker' -AppLogPath $Path -RunMarker $RunMarker)
}

function Read-WatchModeTranslationRoute {
  param([string]$AppLog, [string]$RunMarker)
  return [string](Invoke-WatchModeLogParser -Operation 'translation-route' -AppLogPath $AppLog -RunMarker $RunMarker)
}

function Read-SpeechSegmentationSummary {
  param([string]$AppLog, [string]$RunMarker)
  return Invoke-WatchModeLogParser -Operation 'speech-segmentation' -AppLogPath $AppLog -RunMarker $RunMarker
}

function Get-RecentSubtitleText {
  param([string]$AppLogPath, [string]$RunMarker)
  return [string](Invoke-WatchModeLogParser -Operation 'recent-subtitle-text' -AppLogPath $AppLogPath -RunMarker $RunMarker)
}

function Get-RecentFinalSegmentTranslationText {
  param([string]$AppLogPath, [string]$RunMarker)
  return [string](Invoke-WatchModeLogParser -Operation 'recent-final-segment-translation' -AppLogPath $AppLogPath -RunMarker $RunMarker)
}

Export-ModuleMember -Function @(
  'Get-LogTextAfterMarker',
  'Read-WatchModeTranslationRoute',
  'Read-SpeechSegmentationSummary',
  'Get-RecentSubtitleText',
  'Get-RecentFinalSegmentTranslationText'
)
