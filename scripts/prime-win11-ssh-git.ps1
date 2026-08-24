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

function Invoke-CheckedNative([string]$FilePath, [string[]]$ArgumentList, [string]$Description) {
    $global:LASTEXITCODE = $null
    try {
        & $FilePath @ArgumentList | Out-Null
    } catch {
        throw ($Description + ' failed to start: ' + $_.Exception.Message)
    }
    $exitCode = $global:LASTEXITCODE
    if ($null -eq $exitCode) {
        throw ($Description + ' failed to start or did not return an exit code.')
    }
    if ($exitCode -ne 0) {
        throw ($Description + ' failed with exit code ' + $exitCode + '.')
    }
}

function Assert-AuthorizedKeyAcl([string]$Path, [string[]]$AllowedSidValues) {
    $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    if (-not $acl.AreAccessRulesProtected) {
        throw ('The authorized-key ACL still inherits permissions: ' + $Path)
    }

    $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
    $fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl
    foreach ($rule in $rules) {
        $sidValue = $rule.IdentityReference.Value
        if ($rule.IsInherited -or
            $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
            $AllowedSidValues -notcontains $sidValue) {
            throw ('The authorized-key ACL contains an unexpected access rule for ' + $sidValue + ': ' + $Path)
        }
    }

    foreach ($requiredSid in $AllowedSidValues) {
        $hasFullControl = $false
        foreach ($rule in $rules) {
            if ($rule.IdentityReference.Value -eq $requiredSid -and
                $rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
                (([int]$rule.FileSystemRights -band [int]$fullControl) -eq [int]$fullControl)) {
                $hasFullControl = $true
                break
            }
        }
        if (-not $hasFullControl) {
            throw ('The authorized-key ACL is missing full control for SID ' + $requiredSid + ': ' + $Path)
        }
    }
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
    $userSid = $localUser.SID.Value
    $systemSid = 'S-1-5-18'
    $administratorsSid = 'S-1-5-32-544'
    Invoke-CheckedNative $icacls @(
        $userSsh,
        '/inheritance:r',
        '/grant:r',
        ('*' + $userSid + ':(OI)(CI)(F)'),
        ('*' + $systemSid + ':(OI)(CI)(F)')
    ) 'Securing the user SSH directory with icacls.exe'
    Invoke-CheckedNative $icacls @(
        $userAuthorized,
        '/inheritance:r',
        '/grant:r',
        ('*' + $userSid + ':(F)'),
        ('*' + $systemSid + ':(F)')
    ) 'Securing the user authorized_keys file with icacls.exe'
    Invoke-CheckedNative $icacls @(
        $adminAuthorized,
        '/inheritance:r',
        '/grant:r',
        ('*' + $systemSid + ':(F)'),
        ('*' + $administratorsSid + ':(F)')
    ) 'Securing administrators_authorized_keys with icacls.exe'

    Assert-AuthorizedKeyAcl $userSsh @($userSid, $systemSid)
    Assert-AuthorizedKeyAcl $userAuthorized @($userSid, $systemSid)
    Assert-AuthorizedKeyAcl $adminAuthorized @($systemSid, $administratorsSid)
    Write-Log 'The requested public key was installed without importing a private credential.'
}

function Restore-SshdConfigurationAndService(
    [string]$SshdConfig,
    [bool]$ConfigExisted,
    [byte[]]$PreviousConfig,
    [string]$PreviousStartupType,
    [bool]$WasRunning
) {
    $rollbackFailures = New-Object 'System.Collections.Generic.List[string]'
    try {
        if ($ConfigExisted) {
            [System.IO.File]::WriteAllBytes($SshdConfig, $PreviousConfig)
        } elseif (Test-Path -LiteralPath $SshdConfig) {
            Remove-Item -LiteralPath $SshdConfig -Force -ErrorAction Stop
        }
    } catch {
        $rollbackFailures.Add('config: ' + $_.Exception.Message)
    }

    try {
        $service = Get-Service -Name sshd -ErrorAction Stop
        if ($WasRunning) {
            if ($service.Status -eq [System.ServiceProcess.ServiceControllerStatus]::Running) {
                Restart-Service -Name sshd -Force -ErrorAction Stop
            } else {
                Start-Service -Name sshd -ErrorAction Stop
            }
            (Get-Service -Name sshd -ErrorAction Stop).WaitForStatus(
                [System.ServiceProcess.ServiceControllerStatus]::Running,
                [TimeSpan]::FromSeconds(30)
            )
        } elseif ($service.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Stopped) {
            Stop-Service -Name sshd -Force -ErrorAction Stop
            (Get-Service -Name sshd -ErrorAction Stop).WaitForStatus(
                [System.ServiceProcess.ServiceControllerStatus]::Stopped,
                [TimeSpan]::FromSeconds(30)
            )
        }
    } catch {
        $rollbackFailures.Add('service state: ' + $_.Exception.Message)
    }

    try {
        Set-Service -Name sshd -StartupType $PreviousStartupType -ErrorAction Stop
    } catch {
        $rollbackFailures.Add('startup type: ' + $_.Exception.Message)
    }

    if ($rollbackFailures.Count -gt 0) {
        throw ('Rollback failures: ' + [string]::Join('; ', $rollbackFailures))
    }
}

function Set-PublicKeyOnlySsh {
    $sshdConfig = Join-Path $env:ProgramData 'ssh\sshd_config'
    $configExisted = Test-Path -LiteralPath $sshdConfig -PathType Leaf
    [byte[]]$previousConfig = if ($configExisted) {
        [System.IO.File]::ReadAllBytes($sshdConfig)
    } else {
        $null
    }
    $serviceInfo = Get-CimInstance -ClassName Win32_Service -Filter "Name='sshd'" -ErrorAction Stop
    $previousStartupType = switch ($serviceInfo.StartMode) {
        'Auto' { 'Automatic' }
        'Manual' { 'Manual' }
        'Disabled' { 'Disabled' }
        default { throw ('Unsupported prior sshd startup mode: ' + $serviceInfo.StartMode) }
    }
    $wasRunning = (Get-Service -Name sshd -ErrorAction Stop).Status -eq [System.ServiceProcess.ServiceControllerStatus]::Running

    try {
        if (-not $configExisted) {
            $defaultConfig = Join-Path $env:SystemRoot 'System32\OpenSSH\sshd_config_default'
            if (-not (Test-Path -LiteralPath $defaultConfig -PathType Leaf)) {
                throw 'OpenSSH Server did not provide an sshd_config template.'
            }
            New-Item -ItemType Directory -Path (Split-Path -Parent $sshdConfig) -Force | Out-Null
            Copy-Item -LiteralPath $defaultConfig -Destination $sshdConfig -ErrorAction Stop
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
        Set-Content -LiteralPath $sshdConfig -Value @($hardenedSettings + $configLines) -Encoding ASCII -ErrorAction Stop

        $sshd = Get-Command sshd.exe -ErrorAction Stop
        Invoke-CheckedNative $sshd.Source @('-t', '-f', $sshdConfig) 'Validating the hardened sshd_config'
        Set-Service -Name sshd -StartupType Automatic -ErrorAction Stop
        $service = Get-Service -Name sshd -ErrorAction Stop
        if ($service.Status -eq [System.ServiceProcess.ServiceControllerStatus]::Running) {
            Restart-Service -Name sshd -Force -ErrorAction Stop
        } else {
            Start-Service -Name sshd -ErrorAction Stop
        }
        (Get-Service -Name sshd -ErrorAction Stop).WaitForStatus(
            [System.ServiceProcess.ServiceControllerStatus]::Running,
            [TimeSpan]::FromSeconds(30)
        )
        Write-Log 'OpenSSH is running with public-key-only authentication.'
    } catch {
        $hardeningFailure = $_.Exception.Message
        try {
            Restore-SshdConfigurationAndService $sshdConfig $configExisted $previousConfig $previousStartupType $wasRunning
        } catch {
            throw ('SSH hardening failed: ' + $hardeningFailure + ' Rollback also failed: ' + $_.Exception.Message)
        }
        throw ('SSH hardening failed; the prior sshd_config and service state were restored: ' + $hardeningFailure)
    }
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
    Invoke-CheckedNative (Join-Path $env:SystemRoot 'System32\net.exe') @(
        'user', $GuestUser, '/active:yes', '/passwordreq:yes'
    ) 'Enforcing the local account password policy'
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
    Set-RestrictedSshFirewall

    $gitPath = (Get-Command git.exe -ErrorAction SilentlyContinue).Source
    if (-not $gitPath) {
        $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
        if ($winget) {
            try {
                Invoke-CheckedNative $winget.Source @(
                    'install', '--id', 'Git.Git', '--exact', '--source', 'winget',
                    '--accept-source-agreements', '--accept-package-agreements', '--silent'
                ) 'Installing Git with WinGet'
            } catch {
                Write-Log ('Git installation warning: ' + $_.Exception.Message)
            }
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
