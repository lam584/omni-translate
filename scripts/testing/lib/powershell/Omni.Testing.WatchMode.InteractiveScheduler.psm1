#requires -Version 5.1

Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.Process.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.IO.psm1') -Force

function Stop-GuardedNode {
  param([string]$LaunchPath)
  if (-not (Test-Path -LiteralPath $LaunchPath -PathType Leaf)) { return }
  try {
    $launch = Get-Content -LiteralPath $LaunchPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $processId = [int]$launch.nodeProcess.pid
    $actual = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
    if (-not $actual) { return }
    $process = Get-Process -Id $processId -ErrorAction Stop
    $actualStart = $process.StartTime.ToUniversalTime().ToString('o')
    $actualPath = [string]$actual.ExecutablePath
    if (
      [int]$actual.SessionId -eq [int]$launch.nodeProcess.sessionId -and
      $actualStart -ceq [string]$launch.nodeProcess.startedAt -and
      (Get-OmniSha256 -LiteralPath $actualPath) -ceq [string]$launch.nodeProcess.imageSha256
    ) {
      $lease = [pscustomobject]@{
        schemaVersion = 'omni-process-lease/v1'
        pid = $processId
        startTimeUtcTicks = [long]$process.StartTime.ToUniversalTime().Ticks
        executablePath = $actualPath
        executableSha256 = [string]$launch.nodeProcess.imageSha256
        ownership = 'managed'
        guardianPid = $null
      }
      Stop-OmniOwnedProcessTree -Lease $lease | Out-Null
    }
  } catch {
    # A stale or malformed receipt must never authorize an unguarded process kill.
  }
}

function Invoke-OmniInteractiveFinalizer {
  param(
    [Parameter(Mandatory = $true)][string]$WorkspaceRoot,
    [Parameter(Mandatory = $true)][string]$NodeExecutable,
    [Parameter(Mandatory = $true)][string]$RunnerPath,
    [Parameter(Mandatory = $true)][string]$RequestPath
  )
  if ($WorkspaceRoot -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+\\)') {
    throw 'interactive finalizer workspace must be absolute'
  }
  $workspace = Get-Item -LiteralPath ([IO.Path]::GetFullPath($WorkspaceRoot)) -Force -ErrorAction Stop
  if (-not $workspace.PSIsContainer -or ($workspace.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'interactive finalizer workspace must be a real non-reparse directory'
  }
  foreach ($argument in @($RunnerPath, $RequestPath)) {
    if ($argument.Contains('"') -or $argument.Contains([string][char]0) -or $argument.EndsWith('\')) {
      throw 'interactive finalizer argument is not a safe Windows file argument'
    }
  }
  $process = New-Object System.Diagnostics.Process
  try {
    $process.StartInfo.FileName = $NodeExecutable
    $process.StartInfo.Arguments = '"' + $RunnerPath + '" --finalize-interactive-request "' + $RequestPath + '"'
    $process.StartInfo.WorkingDirectory = $workspace.FullName
    $process.StartInfo.UseShellExecute = $false
    $process.StartInfo.CreateNoWindow = $true
    $process.StartInfo.RedirectStandardOutput = $true
    $process.StartInfo.RedirectStandardError = $true
    if (-not $process.Start()) { throw 'interactive finalizer process did not start' }
    # Drain both streams concurrently; native stderr never enters PowerShell's error stream.
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $nativeExitCode = $process.ExitCode
    $nativeOutput = @($stdout.GetAwaiter().GetResult(), $stderr.GetAwaiter().GetResult())
    if ($null -eq $nativeExitCode -or [int]$nativeExitCode -ne 0) {
      throw "interactive cell guest finalizer failed: exitCode=$nativeExitCode $($nativeOutput -join ' | ')"
    }
    return [pscustomobject]@{ output = @($nativeOutput[0] -split '\r?\n' | Where-Object { $_ }); stderr = $nativeOutput[1]; exitCode = [int]$nativeExitCode }
  } finally {
    $process.Dispose()
  }
}

function Invoke-OmniInteractiveScheduledTask {
  param([Parameter(Mandatory = $true)]$Context)
  foreach ($property in $Context.PSObject.Properties) {
    Set-Variable -Name $property.Name -Value $property.Value -Scope Local
  }
  Write-OmniImmutableJson -LiteralPath $commandPath -Value $command
  $commandSha256 = Get-OmniSha256 -LiteralPath $commandPath
  $arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$launcherPath`" -RequestPath `"$commandPath`" -ExpectedRequestSha256 $commandSha256"
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
    $principal = New-ScheduledTaskPrincipal -UserId $command.expectedUserId -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 12) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  $registered = $false
  try {
    if (Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue) {
      throw 'interactive scheduled task name already exists'
    }
    Register-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Action $action -Principal $principal -Settings $settings | Out-Null
    $registered = $true
    $recorded = Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop
    $recordedXml = [xml](Export-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop)
    if (
      @($recorded.Actions).Count -ne 1 -or
      [string]$recorded.Actions[0].Execute -cne 'powershell.exe' -or
      [string]$recorded.Actions[0].Arguments -cne $arguments -or
      [string]$recorded.Principal.RunLevel -cne 'Limited' -or
      [string]$recordedXml.Task.Actions.Exec.Command -cne 'powershell.exe' -or
      [string]$recordedXml.Task.Actions.Exec.Arguments -cne $arguments -or
      [string]$recordedXml.Task.Principals.Principal.UserId -cne [string]$command.expectedUserSid -or
      [string]$recordedXml.Task.Principals.Principal.LogonType -cne 'InteractiveToken'
    ) { throw 'registered interactive task does not match the immutable action/principal' }
    $taskInfoBeforeStart = Get-ScheduledTaskInfo -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop
    Start-ScheduledTask -TaskPath $taskPath -TaskName $taskName
    $deadline = [DateTime]::UtcNow.AddMilliseconds([int]$payload.timeoutMs)
    $taskObservedRunning = $false
    $taskObservedStarted = $false
    $successfulTaskExitObservedAt = $null
    $terminalVisibilityGraceMilliseconds = 5000
    while (-not (Test-Path -LiteralPath $terminalPath -PathType Leaf)) {
      if ([DateTime]::UtcNow -ge $deadline) { throw 'interactive task timed out before terminal authority' }
      $taskStateBeforeInfo = (Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop).State
      $taskInfo = Get-ScheduledTaskInfo -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop
      $taskStateAfterInfo = (Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction Stop).State
      $taskIsActive = @($taskStateBeforeInfo, $taskStateAfterInfo) | Where-Object {
        $_ -in @('Running', 'Queued')
      } | Select-Object -First 1
      if ($taskStateBeforeInfo -eq 'Running' -or $taskStateAfterInfo -eq 'Running') {
        $taskObservedRunning = $true
      }
      if ($taskObservedRunning -or $taskInfo.LastRunTime -ne $taskInfoBeforeStart.LastRunTime) {
        $taskObservedStarted = $true
      }
      if ($taskIsActive) { $successfulTaskExitObservedAt = $null }
      if (
        $taskObservedStarted -and
        -not $taskIsActive -and
        -not (Test-Path -LiteralPath $terminalPath -PathType Leaf)
      ) {
        $lastTaskResult = [int]$taskInfo.LastTaskResult
        if ($lastTaskResult -ne 0) {
          throw "interactive task exited before terminal authority (LastTaskResult=$lastTaskResult)"
        }
        if ($null -eq $successfulTaskExitObservedAt) {
          $successfulTaskExitObservedAt = [DateTime]::UtcNow
        } elseif (([DateTime]::UtcNow - $successfulTaskExitObservedAt).TotalMilliseconds -ge $terminalVisibilityGraceMilliseconds) {
          throw 'interactive task completed successfully without publishing terminal authority after the visibility grace period'
        }
      }
      Start-Sleep -Milliseconds 250
    }
    while ((Get-ScheduledTask -TaskPath $taskPath -TaskName $taskName).State -in @('Running', 'Queued')) {
      if ([DateTime]::UtcNow -ge $deadline) { throw 'interactive task did not reach scheduler terminal state' }
      Start-Sleep -Milliseconds 250
    }
    $taskInfo = Get-ScheduledTaskInfo -TaskPath $taskPath -TaskName $taskName
    $terminal = Get-Content -LiteralPath $terminalPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $taskTerminal = [ordered]@{
      schemaVersion = 2
      artifactKind = 'watch-mode-interactive-scheduled-task-terminal'
      mode = $mode
      executionId = [string]$payload.executionId
      planDigest = [string]$payload.planDigest
      workerId = [string]$payload.workerId
      vmIdentityDigest = [string]$payload.vmIdentityDigest
      commandSha256 = $commandSha256
      taskName = $taskName
      taskPath = $taskPath
      actionExecute = 'powershell.exe'
      actionArguments = $arguments
      userId = [string]$command.expectedUserId
      logonType = 'InteractiveToken'
      runLevel = 'Limited'
      lastTaskResult = [int]$taskInfo.LastTaskResult
      terminalSha256 = Get-OmniSha256 -LiteralPath $terminalPath
      completedAt = [DateTime]::UtcNow.ToString('o')
    }
    if ($mode -in @('shard-cell', 'incident-plus-cell')) {
      $taskTerminal['leaseId'] = $cellFields.leaseId
      $taskTerminal['leaseDigest'] = $cellFields.leaseDigest
      $taskTerminal['cellId'] = $cellFields.cellId
    } else {
      $taskTerminal['readinessRequestDigest'] = $endpointReadinessFields.readinessRequestDigest
    }
    Write-OmniImmutableJson -LiteralPath $taskTerminalPath -Value $taskTerminal
    if ([int]$terminal.exitCode -ne 0 -or [int]$taskInfo.LastTaskResult -ne 0) {
      throw 'interactive task terminal or Task Scheduler result failed'
    }
    if ($command.mode -in @('shard-cell', 'incident-plus-cell')) {
      if ($terminal.executionReceiptObserved -ne $true -or -not (Test-Path -LiteralPath $executionReceiptPath -PathType Leaf)) {
        throw 'interactive shard did not publish its execution receipt'
      }
      $finalizationRequest = [ordered]@{
        schemaVersion = 1
        artifactKind = 'watch-mode-interactive-cell-finalization-request'
        planPath = [string]$command.planPath
        leasePath = [string]$command.leasePath
        workerId = [string]$command.workerId
        vmUuidBios = [string]$command.expectedVmUuidBios
        shardRoot = [string]$command.shardRoot
        executionReceiptPath = $executionReceiptPath
        readinessReceiptPath = [string]$command.readinessPath
        commandPath = $commandPath
        launchPath = $launchPath
        releasePath = $releasePath
        processAuthorityPath = $processAuthorityPath
        terminalPath = $terminalPath
        taskTerminalPath = $taskTerminalPath
      }
      if ($command.mode -eq 'incident-plus-cell') {
        $finalizationRequest['readinessRequestPath'] = [string]$command.readinessRequestPath
        if ($command.PSObject.Properties['driverReadinessPath']) {
          $finalizationRequest['driverReadinessPath'] = [string]$command.driverReadinessPath
        }
      }
      Write-OmniImmutableJson -LiteralPath $finalizationRequestPath -Value $finalizationRequest
      $finalized = Invoke-OmniInteractiveFinalizer -WorkspaceRoot ([string]$command.workspaceRoot) `
        -NodeExecutable $nodeExecutable -RunnerPath $runnerPath -RequestPath $finalizationRequestPath
      $finalizerOutput = @($finalized.output)
      $finalResultPath = [string](@($finalizerOutput | Where-Object { $_ } | Select-Object -Last 1)[0])
      if (-not (Test-Path -LiteralPath $finalResultPath -PathType Leaf)) {
        throw 'interactive cell guest finalizer returned no immutable result'
      }
    } else {
      $finalResultPath = [string]$terminal.authorityPath
    }
    [ordered]@{
      commandPath = $commandPath
      commandSha256 = $commandSha256
      launchPath = $launchPath
      terminalPath = $terminalPath
      taskTerminalPath = $taskTerminalPath
      processAuthorityPath = $processAuthorityPath
      interactiveAuthorityPath = $interactiveAuthorityPath
      finalizationRequestPath = $finalizationRequestPath
      finalResultPath = $finalResultPath
      terminal = $terminal
      taskTerminal = $taskTerminal
    } | ConvertTo-Json -Depth 20 -Compress
  } finally {
    if ($registered) {
      Stop-ScheduledTask -TaskPath $taskPath -TaskName $taskName -ErrorAction SilentlyContinue
      Stop-GuardedNode $launchPath
      Unregister-ScheduledTask -TaskPath $taskPath -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    }
  }
  
}

Export-ModuleMember -Function 'Invoke-OmniInteractiveScheduledTask'
