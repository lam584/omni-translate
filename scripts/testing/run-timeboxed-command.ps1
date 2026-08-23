param(
  [Parameter(Mandatory = $true)][string]$PayloadBase64,
  [Parameter(Mandatory = $true)][int]$TimeoutMs,
  [Parameter(Mandatory = $true)][string]$StdoutPath,
  [Parameter(Mandatory = $true)][string]$StderrPath,
  [Parameter(Mandatory = $true)][string]$OutcomePath,
  [long]$MinCFreeBytes = 0,
  [ValidateRange(10, 60000)][int]$PollIntervalMs = 5000
)

$ErrorActionPreference = 'Stop'
$startedAt = [DateTimeOffset]::UtcNow
$deadline = [Diagnostics.Stopwatch]::StartNew()
$cDriveSamples = @()
$process = $null

function Write-TimeboxedOutcome {
  param(
    [Parameter(Mandatory = $true)][string]$Reason,
    [Parameter(Mandatory = $true)][int]$ExitCode,
    $Trigger = $null,
    [string]$Failure = $null
  )

  $observedFreeBytes = @(
    $cDriveSamples |
      Where-Object { $null -ne $_.freeBytes } |
      ForEach-Object { [long]$_.freeBytes }
  )
  $minimumCFreeBytes = if ($observedFreeBytes.Count -gt 0) {
    [long](($observedFreeBytes | Measure-Object -Minimum).Minimum)
  } else {
    $null
  }
  $childProcessId = if ($null -ne $process) { $process.Id } else { $null }
  $receipt = [ordered]@{
    schemaVersion = 1
    artifactKind = 'timeboxed-command-outcome'
    reason = $Reason
    exitCode = $ExitCode
    thresholdBytes = [long]$MinCFreeBytes
    trigger = $Trigger
    minimumCFreeBytes = $minimumCFreeBytes
    samples = @($cDriveSamples)
    childProcessId = $childProcessId
    startedAt = $startedAt.ToString('o')
    completedAt = [DateTimeOffset]::UtcNow.ToString('o')
    durationMs = [long]$deadline.ElapsedMilliseconds
    failure = $Failure
  }
  $outcomeDirectory = [IO.Path]::GetDirectoryName($OutcomePath)
  if (-not [string]::IsNullOrWhiteSpace($outcomeDirectory)) {
    [IO.Directory]::CreateDirectory($outcomeDirectory) | Out-Null
  }
  $temporaryOutcomePath = "$OutcomePath.$PID.tmp"
  $utf8WithoutBom = New-Object Text.UTF8Encoding($false)
  [IO.File]::WriteAllText(
    $temporaryOutcomePath,
    (($receipt | ConvertTo-Json -Depth 8) + [Environment]::NewLine),
    $utf8WithoutBom
  )
  Move-Item -LiteralPath $temporaryOutcomePath -Destination $OutcomePath -Force
}

function Stop-TimeboxedProcessTree {
  if ($null -eq $process -or $process.HasExited) { return }
  & taskkill.exe /PID $process.Id /T /F | Out-Null
  $process.WaitForExit()
}

try {
  $payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PayloadBase64)) | ConvertFrom-Json
  foreach ($entry in $payload.environment.PSObject.Properties) {
    [Environment]::SetEnvironmentVariable($entry.Name, [string]$entry.Value, 'Process')
  }

  # All current preflight commands use discrete arguments. Start-Process keeps
  # their process identity available, allowing taskkill /T to stop only the
  # smoke-owned tree when a hard guard ends the command.
  $process = Start-Process -FilePath $payload.command -ArgumentList @($payload.arguments) `
    -WorkingDirectory $payload.cwd -RedirectStandardOutput $StdoutPath `
    -RedirectStandardError $StderrPath -PassThru

  while ($true) {
    $remainingMs = $TimeoutMs - $deadline.ElapsedMilliseconds
    if ($remainingMs -le 0) {
      Stop-TimeboxedProcessTree
      Write-TimeboxedOutcome -Reason 'timeout' -ExitCode 124
      exit 124
    }
    $waitMs = [Math]::Max(1, [Math]::Min([long]$PollIntervalMs, $remainingMs))
    if ($process.WaitForExit([int]$waitMs)) {
      $process.WaitForExit()
      $childExitCode = $process.ExitCode
      Write-TimeboxedOutcome -Reason 'child-exit' -ExitCode $childExitCode
      exit $childExitCode
    }

    if ($MinCFreeBytes -gt 0) {
      try {
        $freeBytes = [long](Get-PSDrive -Name C -ErrorAction Stop).Free
        $sample = [pscustomobject][ordered]@{
          sampledAt = [DateTimeOffset]::UtcNow.ToString('o')
          freeBytes = $freeBytes
          error = $null
        }
      } catch {
        $sample = [pscustomobject][ordered]@{
          sampledAt = [DateTimeOffset]::UtcNow.ToString('o')
          freeBytes = $null
          error = $_.Exception.Message
        }
        $cDriveSamples += $sample
        Stop-TimeboxedProcessTree
        Write-TimeboxedOutcome -Reason 'c-drive-probe-failure' -ExitCode 126 -Trigger $sample -Failure $_.Exception.Message
        exit 126
      }
      $cDriveSamples += $sample
      if ($freeBytes -le $MinCFreeBytes) {
        Stop-TimeboxedProcessTree
        Write-TimeboxedOutcome -Reason 'c-drive-floor' -ExitCode 125 -Trigger $sample
        exit 125
      }
    }

    if ($deadline.ElapsedMilliseconds -ge $TimeoutMs) {
      Stop-TimeboxedProcessTree
      Write-TimeboxedOutcome -Reason 'timeout' -ExitCode 124
      exit 124
    }
  }
} catch {
  $failure = $_.Exception.Message
  try {
    Stop-TimeboxedProcessTree
    Write-TimeboxedOutcome -Reason 'wrapper-failure' -ExitCode 1 -Failure $failure
  } catch {
    # Preserve the original wrapper failure when writing its receipt also fails.
  }
  throw
}
