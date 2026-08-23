[CmdletBinding()]
param(
    [ValidatePattern('^[A-Za-z0-9._ -]+$')]
    [string]$GuestUser = $(if ($env:OMNI_VM_GUEST_USER) { $env:OMNI_VM_GUEST_USER } else { 'VMUser' }),

    [string]$AuthorizedKeyPath = $env:OMNI_VM_AUTHORIZED_KEY_PATH,

    [Security.SecureString]$GuestPassword,

    [ValidateNotNullOrEmpty()]
    [string]$FirewallRemoteAddress = $(if ($env:OMNI_VM_SSH_REMOTE_ADDRESS) { $env:OMNI_VM_SSH_REMOTE_ADDRESS } else { 'LocalSubnet' })
)

$ErrorActionPreference = 'Stop'
$programDataRoot = Join-Path $env:ProgramData 'Win11VmBootstrap'
$logPath = Join-Path $programDataRoot 'prime-ssh-git.log'

New-Item -ItemType Directory -Path $programDataRoot -Force | Out-Null

function Write-Log([string]$Message) {
    $line = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $Message
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
    Write-Output $line
}

function Get-RequiredGuestPassword {
    if ($GuestPassword) {
        return $GuestPassword
    }

    $environmentPassword = [Environment]::GetEnvironmentVariable('OMNI_VM_BOOTSTRAP_PASSWORD', 'Process')
    if ($environmentPassword) {
        if ($environmentPassword.Length -lt 14) {
            throw 'OMNI_VM_BOOTSTRAP_PASSWORD must contain at least 14 characters.'
        }
        try {
            return ConvertTo-SecureString $environmentPassword -AsPlainText -Force
        } finally {
            $environmentPassword = $null
            [Environment]::SetEnvironmentVariable('OMNI_VM_BOOTSTRAP_PASSWORD', $null, 'Process')
        }
    }

    if (-not [Environment]::UserInteractive) {
        throw 'Supply -GuestPassword as a SecureString or set OMNI_VM_BOOTSTRAP_PASSWORD for this process.'
    }
    return Read-Host 'Enter a new strong password for the existing VM account' -AsSecureString
}

function Assert-StrongSecurePassword([Security.SecureString]$Password) {
    if (-not $Password) {
        throw 'A new VM account password is required.'
    }
    $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Password)
    try {
        $passwordLength = [Runtime.InteropServices.Marshal]::ReadInt32($passwordPointer, -4) / 2
        if ($passwordLength -lt 14) {
            throw 'The new VM account password must contain at least 14 characters.'
        }
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    }
}

function Read-AuthorizedPublicKey([string]$Path) {
    if ([string]::IsNullOrWhiteSpace($Path)) {
        throw 'Supply -AuthorizedKeyPath or set OMNI_VM_AUTHORIZED_KEY_PATH to a public-key file.'
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw 'The SSH public-key file does not exist.'
    }
    $publicLine = (Get-Content -Raw -LiteralPath $Path).Trim()
    if ($publicLine -notmatch '^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp(256|384|521))\s+[A-Za-z0-9+/=]+(?:\s+.*)?$' -or $publicLine -match "`r|`n") {
        throw 'The authorized-key file must contain exactly one supported OpenSSH public key.'
    }
    return $publicLine
}

function Disable-AutomaticLogon {
    $winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
    Set-ItemProperty -Path $winlogon -Name 'AutoAdminLogon' -Value '0'
    foreach ($propertyName in @('DefaultPassword', 'DefaultUserName', 'DefaultDomainName', 'AutoLogonCount')) {
        Remove-ItemProperty -Path $winlogon -Name $propertyName -ErrorAction SilentlyContinue
    }
    Write-Log 'Automatic logon is disabled and stored logon values were removed.'
}

function Set-AuthorizedKeys([string]$PublicLine) {
    $localUser = Get-LocalUser -Name $GuestUser -ErrorAction Stop
    $profile = Get-CimInstance -ClassName Win32_UserProfile -ErrorAction SilentlyContinue |
        Where-Object { $_.SID -eq $localUser.SID.Value } |
        Select-Object -First 1
    $userProfile = if ($profile -and $profile.LocalPath) {
        $profile.LocalPath
    } else {
        Join-Path $env:SystemDrive ('Users\' + $GuestUser)
    }
    $userSsh = Join-Path $userProfile '.ssh'
    $userAuthorized = Join-Path $userSsh 'authorized_keys'
    $adminAuthorized = Join-Path $env:ProgramData 'ssh\administrators_authorized_keys'

    foreach ($authorizedPath in @($userAuthorized, $adminAuthorized)) {
        New-Item -ItemType Directory -Path (Split-Path -Parent $authorizedPath) -Force | Out-Null
        $existing = if (Test-Path -LiteralPath $authorizedPath) {
            @(Get-Content -LiteralPath $authorizedPath)
        } else {
            @()
        }
        if ($existing -notcontains $PublicLine) {
            Add-Content -LiteralPath $authorizedPath -Value $PublicLine -Encoding ASCII
        }
    }

    $icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
    & $icacls $userSsh /inheritance:r /grant:r ($env:COMPUTERNAME + '\' + $GuestUser + ':(OI)(CI)(F)') 'SYSTEM:(OI)(CI)(F)' | Out-Null
    & $icacls $adminAuthorized /inheritance:r /grant:r 'SYSTEM:(F)' 'BUILTIN\Administrators:(F)' | Out-Null
    Write-Log 'The requested public key was installed without importing a private credential.'
}

function Set-PublicKeyOnlySsh {
    $sshdConfig = Join-Path $env:ProgramData 'ssh\sshd_config'
    if (-not (Test-Path -LiteralPath $sshdConfig -PathType Leaf)) {
        $defaultConfig = Join-Path $env:SystemRoot 'System32\OpenSSH\sshd_config_default'
        if (-not (Test-Path -LiteralPath $defaultConfig -PathType Leaf)) {
            throw 'OpenSSH Server did not provide an sshd_config template.'
        }
        New-Item -ItemType Directory -Path (Split-Path -Parent $sshdConfig) -Force | Out-Null
        Copy-Item -LiteralPath $defaultConfig -Destination $sshdConfig
    }

    $configLines = @(Get-Content -LiteralPath $sshdConfig -ErrorAction Stop | Where-Object {
        $_ -notmatch '^\s*#?\s*(AuthenticationMethods|PubkeyAuthentication|PasswordAuthentication|KbdInteractiveAuthentication|PermitEmptyPasswords)\s+'
    })
    $hardenedSettings = @(
        'AuthenticationMethods publickey',
        'PubkeyAuthentication yes',
        'PasswordAuthentication no',
        'KbdInteractiveAuthentication no',
        'PermitEmptyPasswords no'
    )
    Set-Content -LiteralPath $sshdConfig -Value @($hardenedSettings + $configLines) -Encoding ASCII

    $sshd = Get-Command sshd.exe -ErrorAction Stop
    & $sshd.Source -t -f $sshdConfig
    if ($LASTEXITCODE -ne 0) {
        throw 'The hardened sshd_config failed validation.'
    }
    Write-Log 'OpenSSH now requires a public key and rejects password authentication.'
}

function Set-RestrictedSshFirewall {
    $firewallRule = Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue
    if (-not $firewallRule) {
        New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Profile Private -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 -RemoteAddress $FirewallRemoteAddress | Out-Null
    } else {
        Set-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -Enabled True -Profile Private -Direction Inbound -Action Allow -ErrorAction Stop
        $firewallRule | Get-NetFirewallAddressFilter | Set-NetFirewallAddressFilter -RemoteAddress $FirewallRemoteAddress | Out-Null
        $firewallRule | Get-NetFirewallPortFilter | Set-NetFirewallPortFilter -Protocol TCP -LocalPort 22 | Out-Null
    }
    Write-Log 'The SSH firewall rule is enabled only for the configured source on Private profiles.'
}

try {
    Write-Log 'Starting existing-VM SSH/Git hardening.'
    $publicLine = Read-AuthorizedPublicKey $AuthorizedKeyPath
    $newPassword = Get-RequiredGuestPassword
    Assert-StrongSecurePassword $newPassword

    Set-LocalUser -Name $GuestUser -Password $newPassword -PasswordNeverExpires $false -ErrorAction Stop
    Enable-LocalUser -Name $GuestUser -ErrorAction SilentlyContinue
    Disable-AutomaticLogon
    & (Join-Path $env:SystemRoot 'System32\net.exe') user $GuestUser /active:yes /passwordreq:yes | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw ('Unable to enforce the local account password policy; net.exe exit code ' + $LASTEXITCODE)
    }
    $newPassword = $null
    Write-Log 'The existing VM account password was rotated and password-required policy is enabled.'

    $client = Get-WindowsCapability -Online -Name 'OpenSSH.Client~~~~0.0.1.0' -ErrorAction SilentlyContinue
    if ($client -and $client.State -ne 'Installed') {
        Add-WindowsCapability -Online -Name 'OpenSSH.Client~~~~0.0.1.0' | Out-Null
    }
    $server = Get-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0' -ErrorAction SilentlyContinue
    if ($server -and $server.State -ne 'Installed') {
        Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0' | Out-Null
    }

    Set-AuthorizedKeys $publicLine
    Set-PublicKeyOnlySsh
    Set-Service -Name sshd -StartupType Automatic -ErrorAction Stop
    Start-Service -Name sshd -ErrorAction SilentlyContinue
    Restart-Service -Name sshd -Force -ErrorAction Stop
    Set-RestrictedSshFirewall

    $gitPath = (Get-Command git.exe -ErrorAction SilentlyContinue).Source
    if (-not $gitPath) {
        $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
        if ($winget) {
            & $winget.Source install --id Git.Git --exact --source winget --accept-source-agreements --accept-package-agreements --silent
            $gitPath = (Get-Command git.exe -ErrorAction SilentlyContinue).Source
        }
    }
    if ($gitPath) {
        Write-Log 'Git is available. Authenticate outbound Git operations interactively with Git Credential Manager.'
    } else {
        Write-Log 'Git was not found; SSH hardening completed.'
    }

    Write-Log 'Existing-VM hardening completed. No private key was copied into the guest.'
} catch {
    Write-Log ('ERROR: ' + $_.Exception.Message)
    exit 1
} finally {
    [Environment]::SetEnvironmentVariable('OMNI_VM_BOOTSTRAP_PASSWORD', $null, 'Process')
}
