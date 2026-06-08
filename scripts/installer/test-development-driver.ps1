param(
  [string]$ExpectedEndpointName = 'Omni Translate Virtual Speaker',
  [string]$WorkspaceRoot = (Join-Path $PSScriptRoot '..\..')
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'virtual-speaker-device.ps1')
$rootDevices = @(Assert-OmniVirtualSpeakerRootDeviceCount 1)
$rootDevice = $rootDevices[0]
if ($rootDevice.Status -ne 'OK') {
  throw "Root\OmniTranslateVirtualSpeaker is not running. Status=$($rootDevice.Status), Problem=$($rootDevice.Problem)"
}

$endpoint = Get-OmniVirtualSpeakerEndpoint $ExpectedEndpointName
if (-not $endpoint) {
  throw "$ExpectedEndpointName endpoint was not found."
}

$status = Invoke-OmniVirtualAudioProbe
if ($status.AbiVersion -notin @(0x20260602, 0x20260604)) {
  throw ('Unexpected driver ABI version: 0x{0:X8}' -f $status.AbiVersion)
}
$audioProbe = Invoke-OmniWasapiAudioProbe $WorkspaceRoot
[pscustomobject]@{
  Endpoint = $endpoint.FriendlyName
  RootInstanceId = $rootDevice.InstanceId
  AbiVersion = ('0x{0:X8}' -f $status.AbiVersion)
  RingCapacityBytes = $status.RingCapacityBytes
  BufferedBytes = $status.BufferedBytes
  MaxBufferedBytes = $status.MaxBufferedBytes
  CapturedBytes = $status.CapturedBytes
  DeliveredBytes = $status.DeliveredBytes
  DroppedBytes = $status.DroppedBytes
  RenderStreamsCreated = $status.RenderStreamsCreated
  RenderRunTransitions = $status.RenderRunTransitions
  RenderSetWritePacketCalls = $status.RenderSetWritePacketCalls
  RenderReadBytesCalls = $status.RenderReadBytesCalls
  LoopbackCaptureReadCalls = $status.LoopbackCaptureReadCalls
  WasapiEndpointId = $audioProbe.endpointId
  CapturedBytesBeforeTone = $audioProbe.capturedBytesBeforeTone
  CapturedBytesAfterTone = $audioProbe.capturedBytesAfterTone
  DeliveredBytesBeforeTone = $audioProbe.deliveredBytesBeforeTone
  DeliveredBytesAfterTone = $audioProbe.deliveredBytesAfterTone
  DroppedBytesAfterTone = $audioProbe.droppedBytesAfterTone
  IdleFrames = $audioProbe.idleFrames
  IdlePeak = $audioProbe.idlePeak
  IdleRms = $audioProbe.idleRms
  ToneFrames = $audioProbe.toneFrames
  TonePeak = $audioProbe.tonePeak
  ToneRms = $audioProbe.toneRms
  ToneFrequencyHz = $audioProbe.toneFrequencyHz
  ToneComponent = $audioProbe.toneComponent
  PostToneIdleFrames = $audioProbe.postToneIdleFrames
  PostToneIdlePeak = $audioProbe.postToneIdlePeak
  PostToneIdleRms = $audioProbe.postToneIdleRms
  SilentPackets = $audioProbe.silentPackets
  InvalidSamples = $audioProbe.invalidSamples
}
