#requires -Version 5.1

Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.IO.psm1') -Force

function Resolve-OmniInteractiveLocalAecFields {
  param([Parameter(Mandatory = $true)]$Payload)
  $names = @('probeRequestPath','probeRequestSha256','outputDirectory','desktopExecutable','desktopExecutableSha256','finalizerHelperPath','finalizerHelperSha256')
  foreach ($name in $names) { if ($null -eq $Payload.PSObject.Properties[$name]) { throw "interactive local AEC request is missing required property $name" } }
  $fields = [ordered]@{ leaseId = [string]$Payload.executionId; leaseDigest = [string]$Payload.probeRequestSha256; cellId = 'local-aec-probe' }
  foreach ($name in $names) { $fields[$name] = [string]$Payload.$name }
  foreach ($entry in @(
    @($fields.probeRequestPath,$fields.probeRequestSha256,'local AEC request'),
    @($fields.desktopExecutable,$fields.desktopExecutableSha256,'Desktop executable'),
    @($fields.finalizerHelperPath,$fields.finalizerHelperSha256,'interactive finalizer helper'))) {
    if (-not (Test-Path -LiteralPath $entry[0] -PathType Leaf) -or (Get-OmniSha256 -LiteralPath $entry[0]) -cne $entry[1]) { throw "$($entry[2]) does not match the signed local AEC request" }
  }
  return $fields
}

Export-ModuleMember -Function 'Resolve-OmniInteractiveLocalAecFields'
