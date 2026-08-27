#requires -Version 5.1

Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.AudioPlayback.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.VirtualDriverCapture.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.WatchMode.PhysicalCapture.psm1') -Force

# Contract anchor for the composed capture surface. Concrete request objects
# are emitted by the child modules, but the aggregate module is also a protocol
# boundary verified by test:contracts.
$protocolVersion = '2026-08-27-audio-routing-v8'

Export-ModuleMember -Function @(
  'Write-TestMediaReferencePcm',
  'Start-TestMediaPlayback',
  'Start-TestMediaPlaybackViaDefaultEndpoint',
  'Invoke-VirtualDriverMediaSourcePreflight',
  'Invoke-PhysicalOutputProbe',
  'Start-PhysicalOutputContentRecorder',
  'Complete-PhysicalOutputContentRecorder'
)
