#requires -Version 5.1

Import-Module (Join-Path $PSScriptRoot 'Omni.Testing.IO.psm1') -Force

function Resolve-OmniInteractiveLocalAecFields {
  param([Parameter(Mandatory = $true)]$Payload)
  $names = @('probeRequestPath','probeRequestSha256','outputDirectory','desktopExecutable','desktopExecutableSha256','finalizerHelperPath','finalizerHelperSha256','desktopIdentityReporterPath','desktopIdentityReporterSha256','nodeDesktopAuthorityPath')
  foreach ($name in $names) { if ($null -eq $Payload.PSObject.Properties[$name]) { throw "interactive local AEC request is missing required property $name" } }
  $fields = [ordered]@{ leaseId = [string]$Payload.executionId; leaseDigest = [string]$Payload.probeRequestSha256; cellId = 'local-aec-probe' }
  foreach ($name in $names) { $fields[$name] = [string]$Payload.$name }
  foreach ($entry in @(
    @($fields.probeRequestPath,$fields.probeRequestSha256,'local AEC request'),
    @($fields.desktopExecutable,$fields.desktopExecutableSha256,'Desktop executable'),
    @($fields.finalizerHelperPath,$fields.finalizerHelperSha256,'interactive finalizer helper'),
    @($fields.desktopIdentityReporterPath,$fields.desktopIdentityReporterSha256,'desktop identity reporter'))) {
    if (-not (Test-Path -LiteralPath $entry[0] -PathType Leaf) -or (Get-OmniSha256 -LiteralPath $entry[0]) -cne $entry[1]) { throw "$($entry[2]) does not match the signed local AEC request" }
  }
  $outputRoot = [IO.Path]::GetFullPath($fields.outputDirectory).TrimEnd('\') + '\'
  $desktopAuthority = [IO.Path]::GetFullPath($fields.nodeDesktopAuthorityPath)
  if (-not $desktopAuthority.StartsWith($outputRoot,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($desktopAuthority) -cne 'node-desktop-identity.json') { throw 'desktop identity authority path is outside the local AEC output root' }
  return $fields
}

Export-ModuleMember -Function 'Resolve-OmniInteractiveLocalAecFields'
