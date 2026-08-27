#requires -Version 5.1

function Invoke-OmniPcmAnalyzer {
  param(
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$WorkspaceRoot
  )

  $executablePath = Join-Path $workspaceRoot 'target/release/omni-benchmark.exe'
  if (-not (Test-Path -LiteralPath $executablePath -PathType Leaf)) {
    throw "frozen omni-benchmark PCM analyzer is missing: $executablePath"
  }
  $output = @(& $executablePath @Arguments)
  if ($LASTEXITCODE -ne 0) {
    throw "omni-benchmark PCM analyzer failed: exitCode=$LASTEXITCODE output=$($output -join ' ')"
  }
  try {
    return ($output -join [Environment]::NewLine) | ConvertFrom-Json
  } catch {
    throw "omni-benchmark PCM analyzer returned invalid JSON: $($_.Exception.Message)"
  }
}

function Measure-PcmAudioQuality {
  param([string]$PcmPath, [int]$SampleRateHz, [Parameter(Mandatory = $true)][string]$WorkspaceRoot)
  if (-not (Test-Path -LiteralPath $PcmPath -PathType Leaf)) {
    return $null
  }
  return Invoke-OmniPcmAnalyzer -WorkspaceRoot $WorkspaceRoot -Arguments @(
    'audio', 'analyze',
    '--input', (Resolve-Path -LiteralPath $PcmPath).Path,
    '--sample-rate', "$SampleRateHz", '--profile', 'watch-physical-output/v1'
  )
}

function Copy-PcmWindow {
  param(
    [string]$SourcePath,
    [string]$DestinationPath,
    [int]$SampleRateHz,
    [int]$Seconds
  )
  if (-not (Test-Path -LiteralPath $SourcePath -PathType Leaf)) {
    return $null
  }
  $bytes = [System.IO.File]::ReadAllBytes($SourcePath)
  $maxBytes = [Math]::Min($bytes.Length, [Math]::Max(1, $SampleRateHz) * [Math]::Max(1, $Seconds) * 2)
  $windowBytes = New-Object byte[] $maxBytes
  [Array]::Copy($bytes, 0, $windowBytes, 0, $maxBytes)
  [System.IO.File]::WriteAllBytes($DestinationPath, $windowBytes)
  return [pscustomobject]@{
    path = $DestinationPath
    sampleRateHz = $SampleRateHz
    seconds = $Seconds
    bytes = $maxBytes
  }
}

function Measure-PcmReferenceSimilarity {
  param(
    [string]$ReferencePcmPath,
    [string]$RecordedPcmPath,
    [int]$SampleRateHz,
    [Parameter(Mandatory = $true)][string]$WorkspaceRoot
  )
  if (-not (Test-Path -LiteralPath $ReferencePcmPath -PathType Leaf)) {
    return [pscustomobject]@{
      passed = $false
      error = "source reference PCM was not created"
      referencePcmPath = $ReferencePcmPath
      recordedPcmPath = $RecordedPcmPath
    }
  }
  if (-not (Test-Path -LiteralPath $RecordedPcmPath -PathType Leaf)) {
    return [pscustomobject]@{
      passed = $false
      error = "physical output PCM window was not created"
      referencePcmPath = $ReferencePcmPath
      recordedPcmPath = $RecordedPcmPath
    }
  }
  $result = Invoke-OmniPcmAnalyzer -WorkspaceRoot $WorkspaceRoot -Arguments @(
    'audio', 'compare',
    '--reference', (Resolve-Path -LiteralPath $ReferencePcmPath).Path,
    '--recorded', (Resolve-Path -LiteralPath $RecordedPcmPath).Path,
    '--sample-rate', "$SampleRateHz", '--profile', 'watch-physical-output/v1'
  )
  $result | Add-Member -NotePropertyName referencePcmPath -NotePropertyValue $ReferencePcmPath -Force
  $result | Add-Member -NotePropertyName recordedPcmPath -NotePropertyValue $RecordedPcmPath -Force
  return $result
}


Export-ModuleMember -Function @(
  'Measure-PcmAudioQuality',
  'Copy-PcmWindow',
  'Measure-PcmReferenceSimilarity'
)
