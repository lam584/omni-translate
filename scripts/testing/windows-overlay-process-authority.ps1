[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('File', 'Process', 'Descendants', 'WebViewRuntime')]
  [string]$Action,

  [string]$LiteralPath,

  [int]$ProcessId,

  [int]$RootProcessId
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$securityModulePath = Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
Import-Module $securityModulePath -ErrorAction Stop

function Get-OmniFileAuthority {
  param([Parameter(Mandatory = $true)][string]$Path)

  $resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
  $item = Get-Item -LiteralPath $resolved -ErrorAction Stop
  if ($item.PSIsContainer) {
    throw "authority path is not a file: $resolved"
  }
  $signature = Get-AuthenticodeSignature -LiteralPath $resolved
  $version = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($resolved)
  return [ordered]@{
    executablePath = $resolved
    sha256 = (Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash.ToLowerInvariant()
    byteCount = [int64]$item.Length
    fileVersion = [string]$version.FileVersion
    productVersion = [string]$version.ProductVersion
    originalFilename = [string]$version.OriginalFilename
    companyName = [string]$version.CompanyName
    signature = [ordered]@{
      status = [string]$signature.Status
      statusMessage = [string]$signature.StatusMessage
      signerSubject = if ($null -ne $signature.SignerCertificate) {
        [string]$signature.SignerCertificate.Subject
      } else { $null }
      signerThumbprint = if ($null -ne $signature.SignerCertificate) {
        [string]$signature.SignerCertificate.Thumbprint
      } else { $null }
      timeStamperSubject = if ($null -ne $signature.TimeStamperCertificate) {
        [string]$signature.TimeStamperCertificate.Subject
      } else { $null }
      timeStamperThumbprint = if ($null -ne $signature.TimeStamperCertificate) {
        [string]$signature.TimeStamperCertificate.Thumbprint
      } else { $null }
    }
  }
}

function Get-OmniProcessAuthorityFromCim {
  param([Parameter(Mandatory = $true)]$Process)

  if ([string]::IsNullOrWhiteSpace([string]$Process.ExecutablePath)) {
    throw "process $($Process.ProcessId) has no readable executable path"
  }
  $file = Get-OmniFileAuthority -Path ([string]$Process.ExecutablePath)
  return [ordered]@{
    processId = [int]$Process.ProcessId
    parentProcessId = [int]$Process.ParentProcessId
    executablePath = $file.executablePath
    sha256 = $file.sha256
    byteCount = $file.byteCount
    fileVersion = $file.fileVersion
    productVersion = $file.productVersion
    originalFilename = $file.originalFilename
    companyName = $file.companyName
    signature = $file.signature
  }
}

function Get-OmniProcessAuthority {
  param([Parameter(Mandatory = $true)][int]$Id)

  $process = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $Id"
  if ($null -eq $process) {
    throw "process $Id is not running"
  }
  return Get-OmniProcessAuthorityFromCim -Process $process
}

function Get-OmniDescendantAuthority {
  param([Parameter(Mandatory = $true)][int]$RootId)

  $all = @(Get-CimInstance -ClassName Win32_Process)
  if (-not ($all | Where-Object { [int]$_.ProcessId -eq $RootId })) {
    throw "root process $RootId is not running"
  }
  $known = [System.Collections.Generic.HashSet[int]]::new()
  [void]$known.Add($RootId)
  $descendants = [System.Collections.Generic.List[object]]::new()
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($process in $all) {
      $id = [int]$process.ProcessId
      $parent = [int]$process.ParentProcessId
      if (-not $known.Contains($id) -and $known.Contains($parent)) {
        [void]$known.Add($id)
        $descendants.Add($process)
        $changed = $true
      }
    }
  }
  return @($descendants | ForEach-Object { Get-OmniProcessAuthorityFromCim -Process $_ })
}

function Get-OmniWebViewRuntimeAuthority {
  $roots = [System.Collections.Generic.List[string]]::new()
  foreach ($base in @(${env:ProgramFiles(x86)}, $env:ProgramFiles)) {
    if (-not [string]::IsNullOrWhiteSpace($base)) {
      $candidate = Join-Path $base 'Microsoft\EdgeWebView\Application'
      if (Test-Path -LiteralPath $candidate -PathType Container) {
        $roots.Add((Resolve-Path -LiteralPath $candidate).Path)
      }
    }
  }
  $candidates = [System.Collections.Generic.List[object]]::new()
  foreach ($root in $roots) {
    foreach ($directory in Get-ChildItem -LiteralPath $root -Directory) {
      $version = $null
      if ([version]::TryParse($directory.Name, [ref]$version)) {
        $executable = Join-Path $directory.FullName 'msedgewebview2.exe'
        if (Test-Path -LiteralPath $executable -PathType Leaf) {
          $candidates.Add([pscustomobject]@{
            ParsedVersion = $version
            Version = $directory.Name
            Executable = $executable
          })
        }
      }
    }
  }
  $selected = $candidates | Sort-Object ParsedVersion -Descending | Select-Object -First 1
  if ($null -eq $selected) {
    throw 'no installed Microsoft Edge WebView2 runtime executable was found'
  }
  $authority = Get-OmniFileAuthority -Path $selected.Executable
  $authority.runtimeVersion = [string]$selected.Version
  return $authority
}

if ($Action -eq 'Descendants') {
  if ($RootProcessId -le 0) { throw '-RootProcessId must be positive for Descendants' }
  $descendants = @(Get-OmniDescendantAuthority -RootId $RootProcessId)
  if ($descendants.Count -eq 0) {
    [Console]::Out.WriteLine('[]')
  } else {
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $descendants -Depth 8 -Compress))
  }
  exit 0
}

$result = switch ($Action) {
  'File' {
    if ([string]::IsNullOrWhiteSpace($LiteralPath)) { throw '-LiteralPath is required for File' }
    Get-OmniFileAuthority -Path $LiteralPath
  }
  'Process' {
    if ($ProcessId -le 0) { throw '-ProcessId must be positive for Process' }
    Get-OmniProcessAuthority -Id $ProcessId
  }
  'WebViewRuntime' {
    Get-OmniWebViewRuntimeAuthority
  }
}

ConvertTo-Json -InputObject $result -Depth 8 -Compress
