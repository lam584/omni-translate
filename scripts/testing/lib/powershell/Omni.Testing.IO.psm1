#requires -Version 5.1

function Set-OmniUtf8NoBomContent {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$LiteralPath,
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value
  )

  $parent = Split-Path -Parent $LiteralPath
  if (-not $parent) { $parent = (Get-Location).Path; $LiteralPath = Join-Path $parent $LiteralPath }
  if ($parent) { [System.IO.Directory]::CreateDirectory($parent) | Out-Null }
  [System.IO.File]::WriteAllText(
    $LiteralPath,
    $Value,
    [System.Text.UTF8Encoding]::new($false)
  )
}

function Get-OmniSha256 {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$LiteralPath)

  if (-not (Test-Path -LiteralPath $LiteralPath -PathType Leaf)) {
    throw "SHA-256 input is not a regular file: $LiteralPath"
  }
  $stream = [System.IO.File]::OpenRead($LiteralPath)
  $algorithm = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = $algorithm.ComputeHash($stream)
    return ([System.BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
  } finally {
    $algorithm.Dispose()
    $stream.Dispose()
  }
}

function Read-OmniJsonFile {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$LiteralPath)

  if (-not (Test-Path -LiteralPath $LiteralPath -PathType Leaf)) {
    throw "JSON file was not found: $LiteralPath"
  }
  try {
    return Get-Content -LiteralPath $LiteralPath -Raw -Encoding UTF8 | ConvertFrom-Json
  } catch {
    throw "JSON file is invalid at '$LiteralPath': $($_.Exception.Message)"
  }
}

function Get-OmniFileLength {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$LiteralPath)

  if (-not (Test-Path -LiteralPath $LiteralPath -PathType Leaf)) {
    return 0L
  }
  return [long](Get-Item -LiteralPath $LiteralPath).Length
}

function Read-OmniTextDelta {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$LiteralPath,
    [ValidateRange(0, [long]::MaxValue)][long]$Offset
  )

  if (-not (Test-Path -LiteralPath $LiteralPath -PathType Leaf)) {
    return ''
  }
  $stream = $null
  $reader = $null
  try {
    $stream = [System.IO.File]::Open(
      $LiteralPath,
      [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Read,
      [System.IO.FileShare]::ReadWrite
    )
    if ($stream.Length -lt $Offset) { $Offset = 0 }
    [void]$stream.Seek($Offset, [System.IO.SeekOrigin]::Begin)
    $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::UTF8, $true)
    return $reader.ReadToEnd()
  } finally {
    if ($null -ne $reader) {
      $reader.Dispose()
    } elseif ($null -ne $stream) {
      $stream.Dispose()
    }
  }
}

function Write-OmniJsonAtomic {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$LiteralPath,
    [Parameter(Mandatory = $true)]$Value,
    [ValidateRange(2, 100)][int]$Depth = 20
  )

  $parent = Split-Path -Parent $LiteralPath
  if (-not $parent) {
    $parent = (Get-Location).Path
    $LiteralPath = Join-Path $parent $LiteralPath
  }
  if ($parent) {
    [System.IO.Directory]::CreateDirectory($parent) | Out-Null
  }
  $fileName = Split-Path -Leaf $LiteralPath
  $temporaryPath = Join-Path $parent ".$fileName.$PID.$([guid]::NewGuid().ToString('N')).tmp"
  try {
    Set-OmniUtf8NoBomContent -LiteralPath $temporaryPath -Value ($Value | ConvertTo-Json -Depth $Depth)
    Move-Item -LiteralPath $temporaryPath -Destination $LiteralPath -Force
  } finally {
    Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
  }
}

function Write-OmniImmutableJson {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$LiteralPath,
    [Parameter(Mandatory = $true)]$Value,
    [ValidateRange(2, 100)][int]$Depth = 20
  )
  $parent = Split-Path -Parent $LiteralPath
  if (-not $parent) {
    $parent = (Get-Location).Path
    $LiteralPath = Join-Path $parent $LiteralPath
  }
  if ($parent) {
    [System.IO.Directory]::CreateDirectory($parent) | Out-Null
  }
  $json = $Value | ConvertTo-Json -Depth $Depth
  $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($json)
  $fileName = Split-Path -Leaf $LiteralPath
  $temporaryPath = Join-Path $parent ".$fileName.$PID.$([guid]::NewGuid().ToString('N')).tmp"
  $stream = $null
  try {
    $stream = [System.IO.File]::Open($temporaryPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
    $stream.Dispose()
    $stream = $null
    # Same-volume File.Move publishes atomically and refuses replacement.
    try { [System.IO.File]::Move($temporaryPath, $LiteralPath) } catch {
      throw "immutable JSON publish failed for '$LiteralPath': $($_.Exception.Message)"
    }
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
    Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
  }
}

function New-OmniTestingOutputDirectory {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$ModelId,
    [Parameter(Mandatory = $true)][string]$FeedbackMode,
    [Parameter(Mandatory = $true)][string]$DeviceProfileId
  )
  $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $modelSuffix = if ($ModelId) { "-$($ModelId -replace '[^A-Za-z0-9_.-]', '_')" } else { '' }
  $feedbackSuffix = if ($FeedbackMode -eq 'virtual-driver') { '' } else { "-$FeedbackMode" }
  $deviceSuffix = "-$($DeviceProfileId -replace '[^A-Za-z0-9_.-]', '_')"
  $resolvedRoot = if ([System.IO.Path]::IsPathRooted($Root)) {
    [System.IO.Path]::GetFullPath($Root)
  } else {
    [System.IO.Path]::GetFullPath((Join-Path (Get-Location).Path $Root))
  }
  $target = Join-Path $resolvedRoot "$timestamp$modelSuffix$feedbackSuffix$deviceSuffix"
  [System.IO.Directory]::CreateDirectory($target) | Out-Null
  return $target
}

Export-ModuleMember -Function @(
  'Set-OmniUtf8NoBomContent',
  'Get-OmniSha256',
  'Read-OmniJsonFile',
  'Get-OmniFileLength',
  'Read-OmniTextDelta',
  'Write-OmniJsonAtomic',
  'Write-OmniImmutableJson',
  'New-OmniTestingOutputDirectory'
)
