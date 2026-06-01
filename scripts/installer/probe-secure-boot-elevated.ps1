param(
  [Parameter(Mandatory = $true)][string]$ResultPath
)

$ErrorActionPreference = 'Stop'
$result = try {
  @{
    secureBootEnabled = [bool](Confirm-SecureBootUEFI)
    status = 'detected'
  }
} catch {
  @{
    secureBootEnabled = $null
    status = 'unavailable'
  }
}

[System.IO.File]::WriteAllText(
  $ResultPath,
  ($result | ConvertTo-Json -Compress),
  (New-Object System.Text.UTF8Encoding($false))
)
