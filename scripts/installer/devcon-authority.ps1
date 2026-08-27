function Test-OmniPathWithinRoot {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Root
  )

  $fullPath = [System.IO.Path]::GetFullPath($Path)
  $fullRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd([char[]]"\/")
  return (
    [string]::Equals($fullPath, $fullRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
    $fullPath.StartsWith(
      $fullRoot + [System.IO.Path]::DirectorySeparatorChar,
      [System.StringComparison]::OrdinalIgnoreCase
    )
  )
}

function Assert-OmniMicrosoftSignedDevcon {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "DevCon executable was not found: $Path"
  }
  if ([System.IO.Path]::GetExtension($Path) -ine '.exe') {
    throw "DevCon authority requires an .exe file: $Path"
  }

  $signatureCommand = Get-Command 'Microsoft.PowerShell.Security\Get-AuthenticodeSignature' -ErrorAction SilentlyContinue
  if (-not $signatureCommand) {
    throw "DevCon must have a valid Microsoft Authenticode signature: signature inspection is unavailable for $Path"
  }
  $signature = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $Path
  $subject = if ($signature.SignerCertificate) {
    [string]$signature.SignerCertificate.Subject
  } else {
    ''
  }
  if (
    $signature.Status -ne 'Valid' -or
    -not $signature.SignerCertificate -or
    $subject -notmatch '(?i)(^|,\s*)O=Microsoft Corporation(,|$)'
  ) {
    throw "DevCon must have a valid Microsoft Authenticode signature: $Path Status=$($signature.Status) Signer=$subject"
  }

  return (Resolve-Path -LiteralPath $Path).Path
}

function Resolve-OmniDevconPath {
  param(
    [Parameter(Mandatory = $true)][string]$WorkspaceRoot,
    [string]$ExplicitPath = ''
  )

  $workspacePath = (Resolve-Path -LiteralPath $WorkspaceRoot).Path
  if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) {
    $candidatePath = if ([System.IO.Path]::IsPathRooted($ExplicitPath)) {
      [System.IO.Path]::GetFullPath($ExplicitPath)
    } else {
      [System.IO.Path]::GetFullPath((Join-Path $workspacePath $ExplicitPath))
    }
    if (-not (Test-OmniPathWithinRoot -Path $candidatePath -Root $workspacePath)) {
      throw "Explicit DevCon path escapes WorkspaceRoot: $candidatePath"
    }
    if (-not (Test-Path -LiteralPath $candidatePath -PathType Leaf)) {
      throw "Explicit DevCon executable was not found: $candidatePath"
    }
    $resolvedCandidate = (Resolve-Path -LiteralPath $candidatePath).Path
    if (-not (Test-OmniPathWithinRoot -Path $resolvedCandidate -Root $workspacePath)) {
      throw "Resolved DevCon path escapes WorkspaceRoot: $resolvedCandidate"
    }
    return Assert-OmniMicrosoftSignedDevcon -Path $resolvedCandidate
  }

  $toolsRoot = 'C:\Program Files (x86)\Windows Kits\10\Tools'
  $candidate = Get-ChildItem -LiteralPath $toolsRoot -Recurse -File -Filter devcon.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\x64\\devcon\.exe$' } |
    Sort-Object FullName -Descending |
    Select-Object -First 1
  if (-not $candidate) {
    throw "WDK devcon.exe was not found under $toolsRoot. Development installs may pass -DevconPath with a Microsoft-signed copy inside WorkspaceRoot."
  }
  return Assert-OmniMicrosoftSignedDevcon -Path $candidate.FullName
}
