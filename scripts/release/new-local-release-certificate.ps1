param(
  [string]$WorkspaceRoot = '.',
  [string]$ReleaseId = (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
)

$ErrorActionPreference = 'Stop'
$workspacePath = (Resolve-Path -LiteralPath $WorkspaceRoot).Path
if ($ReleaseId -notmatch '^[A-Za-z0-9._-]{8,80}$') {
  throw 'ReleaseId contains unsupported characters.'
}
$signingRoot = Join-Path $workspacePath "artifacts\release-signing\$ReleaseId"
if (Test-Path -LiteralPath $signingRoot) {
  throw "Refusing to reuse release signing state: $signingRoot"
}
New-Item -ItemType Directory -Path $signingRoot | Out-Null

$randomBytes = New-Object byte[] 32
$random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $random.GetBytes($randomBytes) } finally { $random.Dispose() }
$password = [Convert]::ToBase64String($randomBytes)
$securePassword = ConvertTo-SecureString -String $password -AsPlainText -Force
$subject = "CN=Omni Translate Local Release $ReleaseId"
$certificate = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject $subject `
  -CertStoreLocation 'Cert:\CurrentUser\My' `
  -HashAlgorithm SHA256 `
  -KeyAlgorithm RSA `
  -KeyLength 3072 `
  -KeyExportPolicy Exportable `
  -NotAfter (Get-Date).AddYears(1)

$pfxPath = Join-Path $signingRoot 'release-code-signing.pfx'
$cerPath = Join-Path $signingRoot 'release-code-signing.cer'
$passwordPath = Join-Path $signingRoot 'password.txt'
$metadataPath = Join-Path $signingRoot 'certificate.json'
$currentPath = Join-Path $workspacePath 'artifacts\release-signing\current.json'
Export-PfxCertificate -Cert $certificate -FilePath $pfxPath -Password $securePassword | Out-Null
Export-Certificate -Cert $certificate -FilePath $cerPath | Out-Null
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($passwordPath, $password, $utf8)
$metadata = [ordered]@{
  schemaVersion = 1
  signingMode = 'local-self-signed'
  releaseId = $ReleaseId
  subject = $certificate.Subject
  thumbprint = $certificate.Thumbprint
  hashAlgorithm = 'SHA256'
  keyAlgorithm = 'RSA'
  keyLength = 3072
  enhancedKeyUsage = 'Code Signing'
  notBefore = $certificate.NotBefore.ToUniversalTime().ToString('o')
  notAfter = $certificate.NotAfter.ToUniversalTime().ToString('o')
  pfxPath = $pfxPath
  certificatePath = $cerPath
  passwordPath = $passwordPath
}
[System.IO.File]::WriteAllText($metadataPath, ($metadata | ConvertTo-Json), $utf8)
[System.IO.File]::WriteAllText($currentPath, ($metadata | ConvertTo-Json), $utf8)
Write-Output $metadataPath
