$ErrorActionPreference = 'Stop'

$sshDir = Join-Path $env:USERPROFILE '.ssh'
$keyPath = Join-Path $sshDir 'id_ed25519_github'
$configPath = Join-Path $sshDir 'config'
$knownHostsPath = Join-Path $sshDir 'known_hosts'
$publicKeyPath = $keyPath + '.pub'
$verificationPath = 'C:\ProgramData\Win11VmBootstrap\github-ssh-verify.log'

New-Item -ItemType Directory -Path $sshDir -Force | Out-Null
if (-not (Test-Path -LiteralPath $keyPath -PathType Leaf)) {
    throw "GitHub private key is missing: $keyPath"
}

$config = @(
    'Host github.com',
    '    HostName github.com',
    '    User git',
    '    IdentityFile C:/Users/VMUser/.ssh/id_ed25519_github',
    '    IdentitiesOnly yes',
    '    StrictHostKeyChecking accept-new'
)
Set-Content -LiteralPath $configPath -Value $config -Encoding ASCII

$sshKeygen = Get-Command ssh-keygen.exe -ErrorAction SilentlyContinue
if ($sshKeygen) {
    $publicKey = & $sshKeygen.Source -y -f $keyPath 2>$null
    if ($LASTEXITCODE -eq 0 -and $publicKey) {
        Set-Content -LiteralPath $publicKeyPath -Value $publicKey -Encoding ASCII
    }
}

$icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
& $icacls $keyPath /inheritance:r /grant:r "$env:USERNAME`:(F)" '*S-1-5-18:(F)' '*S-1-5-32-544:(F)' | Out-Null
& $icacls $configPath /inheritance:r /grant:r "$env:USERNAME`:(F)" '*S-1-5-18:(F)' '*S-1-5-32-544:(F)' | Out-Null
if (Test-Path -LiteralPath $publicKeyPath) {
    & $icacls $publicKeyPath /inheritance:r /grant:r "$env:USERNAME`:(F)" '*S-1-5-18:(F)' '*S-1-5-32-544:(F)' | Out-Null
}

$sshKeyscan = Get-Command ssh-keyscan.exe -ErrorAction SilentlyContinue
if ($sshKeyscan) {
    & $sshKeyscan.Source -H github.com 2>$null | Set-Content -LiteralPath $knownHostsPath -Encoding ASCII
}

$ssh = Get-Command ssh.exe -ErrorAction SilentlyContinue
if ($ssh) {
    & $ssh.Source -T -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 'git@github.com' *>&1 | Tee-Object -FilePath $verificationPath
    Add-Content -LiteralPath $verificationPath -Value ('SSH_EXIT=' + $LASTEXITCODE) -Encoding ASCII
}

Write-Output "GitHub SSH configuration written to $configPath"
