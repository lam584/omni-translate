#requires -Version 5.1

Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.IO.psm1') -Force

function New-ParentGuardedPowerShellCommand {
  param(
    [Parameter(Mandatory = $true)][int]$ParentProcessId,
    [Parameter(Mandatory = $true)][long]$ParentStartTimeUtcTicks,
    [Parameter(Mandatory = $true)][string]$CommandBody
  )
  $guardedCommand = @"
`$parentAlive = `$false
try {
  `$parentProcess = Get-Process -Id $ParentProcessId -ErrorAction Stop
  `$parentProcess.Refresh()
  `$parentAlive = ([long]`$parentProcess.StartTime.ToUniversalTime().Ticks -eq $ParentStartTimeUtcTicks)
} catch {
  `$parentAlive = `$false
}
if (-not `$parentAlive) {
  exit 125
}
$CommandBody
"@
  return [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($guardedCommand))
}

function ConvertTo-PowerShellSingleQuotedLiteral {
  param([AllowEmptyString()][string]$Value)
  return "'" + $Value.Replace("'", "''") + "'"
}

function New-ElevatedDesktopGuardianCommand {
  param(
    [Parameter(Mandatory = $true)][int]$ParentProcessId,
    [Parameter(Mandatory = $true)][long]$ParentStartTimeUtcTicks,
    [Parameter(Mandatory = $true)][string]$LeasePath,
    [Parameter(Mandatory = $true)][string]$EnvironmentPath,
    [Parameter(Mandatory = $true)][string]$ReceiptPath,
    [Parameter(Mandatory = $true)][string]$ExecutablePath,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][string]$StdoutPath,
    [Parameter(Mandatory = $true)][string]$StderrPath
  )
  $leaseLiteral = ConvertTo-PowerShellSingleQuotedLiteral $LeasePath
  $environmentLiteral = ConvertTo-PowerShellSingleQuotedLiteral $EnvironmentPath
  $receiptLiteral = ConvertTo-PowerShellSingleQuotedLiteral $ReceiptPath
  $executableLiteral = ConvertTo-PowerShellSingleQuotedLiteral $ExecutablePath
  $workingDirectoryLiteral = ConvertTo-PowerShellSingleQuotedLiteral $WorkingDirectory
  $stdoutLiteral = ConvertTo-PowerShellSingleQuotedLiteral $StdoutPath
  $stderrLiteral = ConvertTo-PowerShellSingleQuotedLiteral $StderrPath
  $guardianCommand = @"
`$ErrorActionPreference = 'Stop'
`$expectedParentId = $ParentProcessId
`$expectedParentStartTicks = [long]$ParentStartTimeUtcTicks
`$leasePath = $leaseLiteral
`$environmentPath = $environmentLiteral
`$receiptPath = $receiptLiteral
`$desktopProcess = `$null

function Test-RunnerLease {
  if (-not (Test-Path -LiteralPath `$leasePath -PathType Leaf)) {
    return `$false
  }
  try {
    `$parentProcess = Get-Process -Id `$expectedParentId -ErrorAction Stop
    `$parentProcess.Refresh()
    return ([long]`$parentProcess.StartTime.ToUniversalTime().Ticks -eq `$expectedParentStartTicks)
  } catch {
    return `$false
  }
}

function Write-LaunchReceipt {
  param([bool]`$Ok, [string]`$ErrorMessage = '')
  `$payload = if (`$Ok) {
    [ordered]@{
      ok = `$true
      pid = `$desktopProcess.Id
      guardianPid = `$PID
      launchedAtUtc = [DateTime]::UtcNow.ToString('o')
    }
  } else {
    [ordered]@{
      ok = `$false
      guardianPid = `$PID
      error = `$ErrorMessage
    }
  }
  `$temporaryReceiptPath = "`$receiptPath.`$PID.tmp"
  `$utf8 = [System.Text.UTF8Encoding]::new(`$false)
  [System.IO.File]::WriteAllText(`$temporaryReceiptPath, (`$payload | ConvertTo-Json -Compress), `$utf8)
  Move-Item -LiteralPath `$temporaryReceiptPath -Destination `$receiptPath -Force
}

try {
  # ShellExecute can finish long after its requesting runner was terminated.
  # Validate both PID and start time before doing anything irreversible so a
  # recycled PID cannot revive an expired Watch run.
  if (-not (Test-RunnerLease)) {
    exit 125
  }
  `$launchEnvironment = Get-Content -LiteralPath $environmentLiteral -Raw -Encoding UTF8 | ConvertFrom-Json
  foreach (`$property in `$launchEnvironment.PSObject.Properties) {
    `$value = if (`$null -eq `$property.Value) { `$null } else { [string]`$property.Value }
    [System.Environment]::SetEnvironmentVariable(`$property.Name, `$value, [System.EnvironmentVariableTarget]::Process)
  }
  if (-not (Test-RunnerLease)) {
    exit 125
  }
  # Do not use backtick continuations inside this expandable here-string. The
  # outer parser consumes them while constructing the guardian script, which
  # leaves parameters such as -WorkingDirectory as standalone commands.
  `$desktopStartArguments = @{
    FilePath = $executableLiteral
    WorkingDirectory = $workingDirectoryLiteral
    RedirectStandardOutput = $stdoutLiteral
    RedirectStandardError = $stderrLiteral
    WindowStyle = 'Hidden'
    PassThru = `$true
  }
  `$desktopProcess = Start-Process @desktopStartArguments

  while (-not `$desktopProcess.HasExited) {
    if (-not (Test-RunnerLease)) {
      Start-Process -FilePath 'taskkill.exe' `
        -ArgumentList @('/PID', "`$(`$desktopProcess.Id)", '/F', '/T') `
        -WindowStyle Hidden `
        -Wait `
        -ErrorAction SilentlyContinue | Out-Null
      exit 125
    }
    Start-Sleep -Milliseconds 200
    `$desktopProcess.Refresh()
  }
  exit `$desktopProcess.ExitCode
} catch {
  try {
    Write-LaunchReceipt -Ok `$false -ErrorMessage `$_.Exception.Message
  } catch {
  }
  if (`$desktopProcess -and -not `$desktopProcess.HasExited) {
    Start-Process -FilePath 'taskkill.exe' `
      -ArgumentList @('/PID', "`$(`$desktopProcess.Id)", '/F', '/T') `
      -WindowStyle Hidden `
      -Wait `
      -ErrorAction SilentlyContinue | Out-Null
  }
  exit 1
}
"@
  return [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($guardianCommand))
}

function Start-ElevatedWatchModeDesktopShell {
  param(
    [Parameter(Mandatory = $true)][string]$ExecutablePath,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][string]$OutputDirectory,
    [Parameter(Mandatory = $true)][hashtable]$LaunchEnvironment,
    [Parameter(Mandatory = $true)][string]$StdoutPath,
    [Parameter(Mandatory = $true)][string]$StderrPath
  )
  $environmentPath = Join-Path $OutputDirectory 'desktop-shell.elevated-environment.json'
  $receiptPath = Join-Path $OutputDirectory 'desktop-shell.elevated-launch.json'
  $leasePath = Join-Path $OutputDirectory 'desktop-shell.elevated-launch.lease'
  Remove-Item -LiteralPath $receiptPath, $leasePath -Force -ErrorAction SilentlyContinue
  Set-OmniUtf8NoBomContent -LiteralPath $environmentPath -Value ($LaunchEnvironment | ConvertTo-Json -Compress)
  Set-OmniUtf8NoBomContent -LiteralPath $leasePath -Value ([guid]::NewGuid().ToString('N'))

  $runnerProcess = [System.Diagnostics.Process]::GetCurrentProcess()
  $runnerStartTimeUtcTicks = [long]$runnerProcess.StartTime.ToUniversalTime().Ticks
  $encodedCommand = New-ElevatedDesktopGuardianCommand `
    -ParentProcessId $PID `
    -ParentStartTimeUtcTicks $runnerStartTimeUtcTicks `
    -LeasePath $leasePath `
    -EnvironmentPath $environmentPath `
    -ReceiptPath $receiptPath `
    -ExecutablePath $ExecutablePath `
    -WorkingDirectory $WorkingDirectory `
    -StdoutPath $StdoutPath `
    -StderrPath $StderrPath
  try {
    # UAC/ShellExecute is not part of this process tree. The elevated helper
    # therefore owns the desktop and continuously enforces the runner lease.
    $guardianProcess = Start-Process -FilePath 'powershell.exe' `
      -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encodedCommand) `
      -Verb RunAs `
      -WindowStyle Hidden `
      -PassThru
  } catch {
    Remove-Item -LiteralPath $leasePath -Force -ErrorAction SilentlyContinue
    throw
  }

  $receiptDeadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    if (Test-Path -LiteralPath $receiptPath -PathType Leaf) {
      $receipt = Get-Content -LiteralPath $receiptPath -Raw -Encoding UTF8 | ConvertFrom-Json
      if (-not $receipt.ok) {
        Remove-Item -LiteralPath $leasePath -Force -ErrorAction SilentlyContinue
        throw "elevated desktop guardian failed: $($receipt.error)"
      }
      return [pscustomobject]@{
        pid = [int]$receipt.pid
        guardianPid = [int]$receipt.guardianPid
        guardianLeasePath = $leasePath
        guardianEnvironmentPath = $environmentPath
        guardianReceiptPath = $receiptPath
        launchedAtUtc = [DateTime]::Parse([string]$receipt.launchedAtUtc).ToUniversalTime()
      }
    }
    $guardianProcess.Refresh()
    if ($guardianProcess.HasExited) {
      Remove-Item -LiteralPath $leasePath -Force -ErrorAction SilentlyContinue
      throw "elevated desktop guardian exited before launching the desktop shell. ExitCode=$($guardianProcess.ExitCode)"
    }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $receiptDeadline)

  Remove-Item -LiteralPath $leasePath -Force -ErrorAction SilentlyContinue
  throw "timed out waiting for elevated desktop guardian launch receipt: $receiptPath"
}

function Stop-ElevatedWatchModeDesktopLaunch {
  param($Launch)
  if (-not $Launch) {
    return [pscustomobject]@{ stopped = $false; reason = 'no tracked elevated desktop launch' }
  }
  if ($Launch.guardianLeasePath) {
    Remove-Item -LiteralPath $Launch.guardianLeasePath -Force -ErrorAction SilentlyContinue
  }
  $guardianPid = if ($Launch.guardianPid) { [int]$Launch.guardianPid } else { 0 }
  $deadline = [DateTime]::UtcNow.AddSeconds(3)
  while ($guardianPid -gt 0 -and (Get-Process -Id $guardianPid -ErrorAction SilentlyContinue) -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 100
  }
  return [pscustomobject]@{
    stopped = $true
    pid = $Launch.pid
    guardianPid = $guardianPid
    guardianExited = ($guardianPid -le 0 -or -not (Get-Process -Id $guardianPid -ErrorAction SilentlyContinue))
  }
}


Export-ModuleMember -Function @(
  'New-ParentGuardedPowerShellCommand',
  'New-ElevatedDesktopGuardianCommand',
  'Start-ElevatedWatchModeDesktopShell',
  'Stop-ElevatedWatchModeDesktopLaunch'
)
