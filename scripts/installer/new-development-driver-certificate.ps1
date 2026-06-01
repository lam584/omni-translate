param(
  [string]$WorkspaceRoot = '.',
  [string]$Subject = 'CN=Omni Translate Development Driver Test Signing'
)

$ErrorActionPreference = 'Stop'
$workspacePath = (Resolve-Path -LiteralPath $WorkspaceRoot).Path
$signingRoot = Join-Path $workspacePath 'artifacts\driver-signing\development'
$pfxPath = Join-Path $signingRoot 'omni-translate-development-driver.pfx'
$cerPath = Join-Path $signingRoot 'omni-translate-development-driver.cer'
$passwordPath = Join-Path $signingRoot 'password.txt'
$metadataPath = Join-Path $signingRoot 'certificate.json'

New-Item -ItemType Directory -Force -Path $signingRoot | Out-Null
$randomBytes = New-Object byte[] 32
$random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
  $random.GetBytes($randomBytes)
} finally {
  $random.Dispose()
}
$password = [Convert]::ToBase64String($randomBytes)
$securePassword = ConvertTo-SecureString -String $password -AsPlainText -Force
$certificate = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject $Subject `
  -CertStoreLocation 'Cert:\CurrentUser\My' `
  -HashAlgorithm SHA256 `
  -KeyAlgorithm RSA `
  -KeyLength 3072 `
  -KeyExportPolicy Exportable `
  -NotAfter (Get-Date).AddYears(3)

Export-PfxCertificate -Cert $certificate -FilePath $pfxPath -Password $securePassword | Out-Null
Export-Certificate -Cert $certificate -FilePath $cerPath | Out-Null
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($passwordPath, $password, $utf8NoBom)
$metadata = [ordered]@{
  subject = $certificate.Subject
  thumbprint = $certificate.Thumbprint
  notBefore = $certificate.NotBefore.ToUniversalTime().ToString('o')
  notAfter = $certificate.NotAfter.ToUniversalTime().ToString('o')
  pfxPath = $pfxPath
  certificatePath = $cerPath
}
[System.IO.File]::WriteAllText($metadataPath, ($metadata | ConvertTo-Json), $utf8NoBom)
Write-Output "Development driver test certificate generated at $cerPath"
Write-Output 'The PFX and password remain under artifacts and must never be committed.'
