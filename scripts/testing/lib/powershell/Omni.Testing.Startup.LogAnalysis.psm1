#requires -Version 5.1

function Read-NewTextFromFile {
  param(
    [string]$Path,
    [long]$Offset
  )

  if (-not (Test-Path $Path)) {
    return [pscustomobject]@{ Text = ''; Offset = 0 }
  }

  $file = Get-Item $Path
  if ($file.Length -lt $Offset) {
    $Offset = 0
  }

  $stream = $null
  $reader = $null
  try {
    $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    [void]$stream.Seek($Offset, [System.IO.SeekOrigin]::Begin)
    $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8, $true)
    $text = $reader.ReadToEnd()
    $newOffset = $stream.Position
    return [pscustomobject]@{ Text = $text; Offset = $newOffset }
  } finally {
    if ($null -ne $reader) {
      $reader.Dispose()
    } elseif ($null -ne $stream) {
      $stream.Dispose()
    }
  }
}

function Find-ReadyMarker {
  param(
    [string]$Text,
    [string]$RunId
  )

  foreach ($line in ($Text -split "`r?`n")) {
    if ([string]::IsNullOrWhiteSpace($line)) {
      continue
    }
    if (-not $line.Contains('startup.readiness_ready')) {
      continue
    }
    if (-not $line.Contains("runId=$RunId")) {
      continue
    }

    $payload = $null
    $payloadError = $null
    if ($line -match 'payload=([^ ]+)') {
      try {
        $payloadJson = [System.Uri]::UnescapeDataString($Matches[1])
        $payload = $payloadJson | ConvertFrom-Json
      } catch {
        $payloadError = $_.Exception.Message
      }
    }

    $logTimestamp = $null
    if ($line -match '^(?<timestamp>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})') {
      try {
        $logTimestamp = [DateTime]::ParseExact(
          $Matches['timestamp'],
          'yyyy-MM-dd HH:mm:ss.fff',
          [System.Globalization.CultureInfo]::InvariantCulture,
          [System.Globalization.DateTimeStyles]::AssumeLocal
        )
      } catch {
        $logTimestamp = $null
      }
    }

    return [pscustomobject]@{
      Line = $line
      LogTimestamp = $logTimestamp
      Payload = $payload
      PayloadError = $payloadError
    }
  }

  return $null
}


function Find-FullReadyMarkers {
  param(
    [string]$Text
  )

  $markers = [ordered]@{
    routeReady = $null
    stylesReady = $null
    bridgeConverged = $null
    fullReady = $null
  }

  foreach ($line in ($Text -split "`r?`n")) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }

    $logTimestamp = $null
    if ($line -match '^(?<timestamp>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})') {
      try {
        $logTimestamp = [DateTime]::ParseExact(
          $Matches['timestamp'],
          'yyyy-MM-dd HH:mm:ss.fff',
          [System.Globalization.CultureInfo]::InvariantCulture,
          [System.Globalization.DateTimeStyles]::AssumeLocal
        )
      } catch { $logTimestamp = $null }
    }

    if ($line.Contains('startup.route_ready') -and -not $markers.routeReady) {
      $markers.routeReady = [pscustomobject]@{ detected = $true; timestamp = $logTimestamp; line = $line }
    }
    if ($line.Contains('startup.styles_ready') -and -not $markers.stylesReady) {
      $markers.stylesReady = [pscustomobject]@{ detected = $true; timestamp = $logTimestamp; line = $line }
    }
    if ($line.Contains('startup.bridge_converged') -and -not $markers.bridgeConverged) {
      $detail = ''
      if ($line -match 'convergence=(\w+)') { $detail = $Matches[1] }
      $markers.bridgeConverged = [pscustomobject]@{ detected = $true; timestamp = $logTimestamp; line = $line; convergence = $detail }
    }
    if ($line.Contains('startup.full_ready') -and -not $markers.fullReady) {
      $markers.fullReady = [pscustomobject]@{ detected = $true; timestamp = $logTimestamp; line = $line }
    }
  }

  return $markers
}
function Read-TextFileIfExists {
  param([string]$Path)

  if (-not (Test-Path $Path)) {
    return ''
  }

  return Get-Content -Raw -Encoding UTF8 -Path $Path
}


Export-ModuleMember -Function @('Read-NewTextFromFile','Find-ReadyMarker','Find-FullReadyMarkers','Read-TextFileIfExists')
