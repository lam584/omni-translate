#requires -Version 5.1

function Ensure-ObjectProperty {
  param($Object, [string]$Name)
  if (-not $Object.PSObject.Properties[$Name] -or $null -eq $Object.$Name) {
    $Object | Add-Member -NotePropertyName $Name -NotePropertyValue ([pscustomobject]@{}) -Force
  }
  return $Object.$Name
}

function Ensure-ValueProperty {
  param($Object, [string]$Name)
  if (-not $Object.PSObject.Properties[$Name]) {
    $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $null
  }
}

function Enter-StrictPaidProviderEnvironment {
  param(
    [bool]$Enabled,
    [bool]$IncidentReplay = $false,
    [bool]$LocalSingleSession = $false
  )
  $fixed = [ordered]@{
    OMNI_WATCH_MODE_EXPECTED_PROVIDER_ID = "provider-dashscope"
    OMNI_WATCH_MODE_EXPECTED_PROVIDER_TEMPLATE_ID = "template-dashscope-realtime"
    OMNI_WATCH_MODE_EXPECTED_PROVIDER_KIND = "dashscope"
    OMNI_WATCH_MODE_EXPECTED_PROVIDER_ENDPOINT_HOST = "dashscope.aliyuncs.com"
    OMNI_WATCH_MODE_EXPECTED_PROVIDER_CREDENTIAL_REFERENCE = "credential://provider/dashscope/default"
  }
  if ($Enabled) {
    $fixed.OMNI_WATCH_MODE_STRICT_PAID_AUTHORITY = "1"
  }
  if ($IncidentReplay) {
    $fixed.OMNI_WATCH_MODE_INCIDENT_REPLAY_AUTHORITY = "1"
    $fixed.OMNI_WATCH_MODE_INCIDENT_ID = "watch-mode-loss-incident-plus-v1"
  }
  if ($LocalSingleSession) {
    $fixed.OMNI_WATCH_MODE_LOCAL_SINGLE_SESSION_AUTHORITY = "1"
  }
  $previous = [ordered]@{}
  foreach ($entry in $fixed.GetEnumerator()) {
    $previous[$entry.Key] = [Environment]::GetEnvironmentVariable(
      $entry.Key,
      [EnvironmentVariableTarget]::Process
    )
    if ($Enabled -or $IncidentReplay -or $LocalSingleSession) {
      [Environment]::SetEnvironmentVariable(
        $entry.Key,
        [string]$entry.Value,
        [EnvironmentVariableTarget]::Process
      )
    }
  }
  return [pscustomobject]@{
    enabled = $Enabled -or $IncidentReplay -or $LocalSingleSession
    names = @($fixed.Keys)
    values = $fixed
    previous = $previous
  }
}

function Exit-StrictPaidProviderEnvironment {
  param($State)
  if (-not $State) { return }
  foreach ($name in @($State.names)) {
    [Environment]::SetEnvironmentVariable(
      [string]$name,
      $State.previous[[string]$name],
      [EnvironmentVariableTarget]::Process
    )
  }
}

function Set-WatchModelOnConfig {
  param(
    $Config,
    [string]$ModelId,
    [string]$RealtimeProtocol = "",
    [bool]$RequireStrictProvider = $false
  )
  if (-not $ModelId) {
    return
  }
  if (-not $Config.devices) {
    $Config | Add-Member -NotePropertyName devices -NotePropertyValue ([pscustomobject]@{})
  }
  $Config.devices.inboundVoiceModelId = $ModelId
  $Config.devices.outboundVoiceModelId = $ModelId
  $Config.devices.textToSpeechModelId = $ModelId
  if (-not $Config.speech) {
    $Config | Add-Member -NotePropertyName speech -NotePropertyValue ([pscustomobject]@{})
  }
  $Config.speech.textToSpeechModelId = $ModelId
  if ($RealtimeProtocol) {
    $separator = $ModelId.IndexOf("::")
    $templateId = if ($separator -ge 0) { $ModelId.Substring(0, $separator) } else { "" }
    $resolvedModelId = if ($separator -ge 0) { $ModelId.Substring($separator + 2) } else { $ModelId }
    if ($RequireStrictProvider) {
      if ($RealtimeProtocol -notin @("dashscope-omni", "dashscope-livetranslate")) {
        throw "Strict paid Watch provider requires a budget-approved DashScope realtime protocol."
      }
      $strictProviders = @($Config.providers | Where-Object {
        $_.providerId -ceq "provider-dashscope" -and
        $_.templateId -ceq "template-dashscope-realtime"
      })
      if ($strictProviders.Count -ne 1) {
        throw "Strict paid Watch provider requires exactly one provider-dashscope/template-dashscope-realtime entry."
      }
      $provider = $strictProviders[0]
      $providerUri = $null
      if (-not [Uri]::TryCreate([string]$provider.baseUrl, [UriKind]::Absolute, [ref]$providerUri)) {
        throw "Strict paid Watch provider baseUrl is not an absolute URI."
      }
      if (
        $provider.kind -cne "dashscope" -or
        $providerUri.Scheme -cne "https" -or
        -not [string]::IsNullOrEmpty($providerUri.UserInfo) -or
        -not $providerUri.IsDefaultPort -or
        $providerUri.Host -cne "dashscope.aliyuncs.com" -or
        $provider.streamEnabled -ne $true -or
        $provider.authRef.kind -cne "credential-ref" -or
        $provider.authRef.reference -cne "credential://provider/dashscope/default" -or
        $provider.authRef.headerName -cne "Authorization" -or
        $provider.authRef.scheme -cne "bearer" -or
        @($provider.customHeaders).Count -ne 0 -or
        $provider.systemPromptTemplate -cne "game-live-translation-cn" -or
        $provider.timeoutMs -ne 12000 -or
        [double]$provider.temperature -ne 0.2 -or
        $provider.maxOutputTokens -ne 256 -or
        @($provider.responseModalities).Count -ne 1 -or
        @($provider.responseModalities)[0] -cne "text"
      ) {
        throw "Strict paid Watch provider identity, endpoint, or credential reference does not match the signed authority."
      }
    } else {
      $provider = @($Config.providers | Where-Object {
        ($templateId -and $_.templateId -eq $templateId) -or
        (-not $templateId -and (
          ($RealtimeProtocol -like "dashscope-*" -and $_.kind -eq "dashscope") -or
          ($RealtimeProtocol -like "openai-*" -and $_.kind -eq "openai-compatible") -or
          ($RealtimeProtocol -eq "gemini-live" -and $_.templateId -like "*gemini*")
        ))
      } | Select-Object -First 1)
    }
    if (-not $provider) {
      throw "No provider can host explicit Watch realtime protocol '$RealtimeProtocol'."
    }
    $provider.model = $resolvedModelId
    $capabilities = if ($RealtimeProtocol -in @("dashscope-asr", "openai-transcription")) {
      @("speech-to-text")
    } else {
      @("speech-to-text", "speech-to-speech")
    }
    $entry = [pscustomobject]@{
      id = "watch-live-explicit-alias"
      modelId = $resolvedModelId
      capabilities = $capabilities
      realtimeProtocol = $RealtimeProtocol
      realtimeAudioMode = if ($RealtimeProtocol -eq "dashscope-omni") { "manual" } else { "server_vad" }
      interactionCapabilities = if ($RealtimeProtocol -eq "dashscope-omni") {
        @("manual_commit", "streaming")
      } else {
        @("streaming", "auto_vad")
      }
    }
    $existing = @($provider.localModelCapabilityRegistry | Where-Object { $_.modelId -ne $resolvedModelId })
    $provider.localModelCapabilityRegistry = @($entry) + $existing
  }
}

function Set-WatchModeSecondaryConfig {
  param(
    $Config,
    [string]$SubtitleModelId,
    [string]$SecondaryAudioModelId,
    [Parameter(Mandatory = $true)]
    [ValidateSet('virtual-driver', 'process-exclusion', 'echo-cancel')]
    [string]$FeedbackMode,
    [Parameter(Mandatory = $true)]
    [ValidateSet("native", "secondary")]
    [string]$TranslationMode
  )
  if (-not $Config.devices) {
    $Config | Add-Member -NotePropertyName devices -NotePropertyValue ([pscustomobject]@{})
  }
  if (-not $Config.speech) {
    $Config | Add-Member -NotePropertyName speech -NotePropertyValue ([pscustomobject]@{})
  }
  $inboundRoute = Ensure-ObjectProperty $Config.devices "inboundRoute"
  $mixControl = Ensure-ObjectProperty $inboundRoute "mixControl"
  foreach ($name in @(
    "subtitleTranslationMode",
    "subtitleTranslationModelId",
    "inboundSecondaryAudioModelId",
    "textToSpeechModelId",
    "outputSpeechEnabled",
    "feedbackLoopPrevention"
  )) {
    Ensure-ValueProperty $Config.devices $name
  }
  foreach ($name in @(
    "textToSpeechModelId",
    "enabled",
    "outputTarget",
    "localPlaybackEnabled",
    "virtualMicOutputEnabled",
    "translationAudioSource"
  )) {
    Ensure-ValueProperty $Config.speech $name
  }
  foreach ($name in @(
    "keepOriginalAudio",
    "translatedAudioEnabled",
    "originalAudioGainDb",
    "translatedAudioGainDb",
    "duckingEnabled",
    "monitorMode"
  )) {
    Ensure-ValueProperty $mixControl $name
  }
  if ($TranslationMode -eq "native") {
    $Config.devices.subtitleTranslationMode = "native"
    $Config.devices.subtitleTranslationModelId = ""
    $Config.devices.inboundSecondaryAudioModelId = ""
    $Config.devices.outputSpeechEnabled = $true
    $Config.devices.feedbackLoopPrevention = $FeedbackMode
    $mixControl.keepOriginalAudio = $true
    $mixControl.translatedAudioEnabled = $true
    $mixControl.originalAudioGainDb = 0
    $mixControl.translatedAudioGainDb = 0
    $mixControl.duckingEnabled = $true
    $mixControl.monitorMode = "original-and-translated"
    $Config.speech.enabled = $true
    $Config.speech.outputTarget = "speaker"
    $Config.speech.localPlaybackEnabled = $true
    $Config.speech.virtualMicOutputEnabled = $false
    $Config.speech.translationAudioSource = "omni-native"
    return
  }
  $Config.devices.subtitleTranslationMode = "secondary"
  if ($SubtitleModelId) {
    $Config.devices.subtitleTranslationModelId = $SubtitleModelId
  }
  if ($SecondaryAudioModelId) {
    $Config.devices.inboundSecondaryAudioModelId = $SecondaryAudioModelId
    $Config.devices.textToSpeechModelId = $SecondaryAudioModelId
    $Config.speech.textToSpeechModelId = $SecondaryAudioModelId
  }
  $Config.devices.outputSpeechEnabled = $true
  $Config.devices.feedbackLoopPrevention = $FeedbackMode
  $mixControl.keepOriginalAudio = $true
  $mixControl.translatedAudioEnabled = $true
  $mixControl.originalAudioGainDb = 0
  $mixControl.translatedAudioGainDb = 0
  $mixControl.duckingEnabled = $true
  $mixControl.monitorMode = "original-and-translated"
  $Config.speech.enabled = $true
  $Config.speech.outputTarget = "speaker"
  $Config.speech.localPlaybackEnabled = $true
  $Config.speech.virtualMicOutputEnabled = $false
  $Config.speech.translationAudioSource = "subtitle-tts"
}

function Get-WatchModeLiveScenarioEnvironment {
  param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('virtual-driver', 'process-exclusion', 'echo-cancel')]
    [string]$FeedbackMode,
    [Parameter(Mandatory = $true)] [ValidateRange(30000, 7200000)] [int64]$AutoStopAfterMs,
    [ValidateRange(0, 7200000)] [int64]$ProcessExclusionRestartAfterMs = 90000
  )
  if ($FeedbackMode -eq 'process-exclusion' -and $ProcessExclusionRestartAfterMs -le 0) {
    throw 'process-exclusion requires an explicit positive restart offset'
  }
  return [pscustomobject]@{
    autoStopAfterMs = "$AutoStopAfterMs"
    processExclusionRestartAfterMs = if ($FeedbackMode -eq 'process-exclusion') {
      "$ProcessExclusionRestartAfterMs"
    } else { $null }
    aecLiveScenario = if ($FeedbackMode -eq 'echo-cancel') { '1' } else { $null }
  }
}

Export-ModuleMember -Function @(
  'Enter-StrictPaidProviderEnvironment',
  'Exit-StrictPaidProviderEnvironment',
  'Set-WatchModelOnConfig',
  'Set-WatchModeSecondaryConfig',
  'Get-WatchModeLiveScenarioEnvironment'
)
