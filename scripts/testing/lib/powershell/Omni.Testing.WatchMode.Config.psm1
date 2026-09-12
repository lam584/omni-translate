#requires -Version 5.1

function New-OmniWatchModeContext {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]$Request,
    [Parameter(Mandatory = $true)][string]$WorkspaceRoot
  )

  if ($Request.schemaVersion -cne 'watch-mode-run-request/v1') {
    throw "unsupported Watch Mode request schema: $($Request.schemaVersion)"
  }
  $driverPolicy = [string]$Request.driverPolicy
  $feedbackMode = [string]$Request.feedbackMode
  if ($feedbackMode -eq 'virtual-driver' -and $driverPolicy -eq 'not-applicable') {
    throw 'virtual-driver requires an explicit driver probe policy'
  }
  if ($feedbackMode -ne 'virtual-driver' -and $driverPolicy -ne 'not-applicable') {
    throw "$feedbackMode cannot perform virtual-driver operations"
  }
  $localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
  if ([string]::IsNullOrWhiteSpace($localAppData)) {
    throw 'LocalApplicationData is unavailable for the release desktop log.'
  }
  $sessionWatchdogSeconds = [int]$Request.timeouts.sessionSeconds

  return [pscustomobject]@{
    schemaVersion = 'watch-mode-run-context/v2'
    request = $Request
    mode = [string]$Request.runMode
    audioRoute = $feedbackMode
    authorityMode = [string]$Request.authorityMode
    driverPolicy = $driverPolicy
    physicalContentMode = [string]$Request.physicalContentMode
    desktop = [pscustomobject]@{
      launchMode = [string]$Request.desktop.launchMode
      elevation = [string]$Request.desktop.elevation
    }
    paths = [pscustomobject]@{
      workspaceRoot = [IO.Path]::GetFullPath($WorkspaceRoot)
      outputRoot = [string]$Request.paths.outputRoot
      runtimeRoot = [string]$Request.paths.runtimeRoot
      appLogPath = Join-Path $localAppData 'OmniTranslate\diagnostics\logs\app.log'
    }
    timeouts = $Request.timeouts
    lifecycle = [pscustomobject]@{
      sessionWatchdogSeconds = $sessionWatchdogSeconds
      inputCompletionWatchdogSeconds = [int]$Request.timeouts.inputCompletionWatchdogSeconds
      processExclusionRestartAfterSeconds = [int]$Request.timeouts.processExclusionRestartAfterSeconds
      processExclusionRestartQuietSeconds = [int]$Request.timeouts.processExclusionRestartQuietSeconds
      providerFinishTimeoutSeconds = [int]$Request.timeouts.providerFinishTimeoutSeconds
      localPlaybackDrainTimeoutSeconds = [int]$Request.timeouts.localPlaybackDrainTimeoutSeconds
      reportWriteTimeoutSeconds = [int]$Request.timeouts.reportWriteTimeoutSeconds
      cellHardWatchdogSeconds = [int]$Request.timeouts.cellHardWatchdogSeconds
      physicalRecorderTailSeconds = [int]$Request.timeouts.physicalRecorderTailSeconds
    }
    media = $Request.media
    model = $Request.model
    physicalDevice = $Request.physicalDevice
    matrix = $Request.matrix
  }
}

Export-ModuleMember -Function 'New-OmniWatchModeContext'
