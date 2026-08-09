$ErrorActionPreference = 'Stop'

$guestUser = 'VMUser'
$temporaryPassword = 'VmSetup!2026'
$programDataRoot = Join-Path $env:ProgramData 'Win11VmBootstrap'
$logPath = Join-Path $programDataRoot 'prime-ssh-git.log'

New-Item -ItemType Directory -Path $programDataRoot -Force | Out-Null

function Write-Log([string]$Message) {
    $line = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $Message
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
    Write-Output $line
}

try {
    Write-Log 'Starting SSH/Git bootstrap.'

    $securePassword = ConvertTo-SecureString $temporaryPassword -AsPlainText -Force
    Set-LocalUser -Name $guestUser -Password $securePassword -ErrorAction Stop
    Enable-LocalUser -Name $guestUser -ErrorAction SilentlyContinue
    Write-Log 'Temporary password set for VMUser.'

    $client = Get-WindowsCapability -Online -Name 'OpenSSH.Client~~~~0.0.1.0' -ErrorAction SilentlyContinue
    if ($client -and $client.State -ne 'Installed') {
        Add-WindowsCapability -Online -Name 'OpenSSH.Client~~~~0.0.1.0' | Out-Null
    }
    $server = Get-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0' -ErrorAction SilentlyContinue
    if ($server -and $server.State -ne 'Installed') {
        Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0' | Out-Null
    }

    $shareCandidates = @(
        (Join-Path $PSScriptRoot 'host-share'),
        'E:\VMs\Win11_25H2_1\host-share',
        '\\vmware-host\Shared Folders\HostShare'
    )
    $share = $shareCandidates | Where-Object {
        (Test-Path -LiteralPath (Join-Path $_ 'host_admin.pub')) -or
        (Test-Path -LiteralPath (Join-Path $_ 'id_ed25519_github'))
    } | Select-Object -First 1

    $userProfile = Join-Path $env:SystemDrive 'Users\VMUser'
    $userSsh = Join-Path $userProfile '.ssh'
    New-Item -ItemType Directory -Path $userSsh -Force | Out-Null

    if ($share) {
        $hostPublic = Join-Path $share 'host_admin.pub'
        if (Test-Path -LiteralPath $hostPublic) {
            $publicLine = (Get-Content -Raw -LiteralPath $hostPublic).Trim()
            $adminAuthorized = Join-Path $env:ProgramData 'ssh\administrators_authorized_keys'
            $userAuthorized = Join-Path $userSsh 'authorized_keys'
            foreach ($authorizedPath in @($adminAuthorized, $userAuthorized)) {
                New-Item -ItemType Directory -Path (Split-Path -Parent $authorizedPath) -Force | Out-Null
                $existing = if (Test-Path -LiteralPath $authorizedPath) { @(Get-Content -LiteralPath $authorizedPath) } else { @() }
                if ($existing -notcontains $publicLine) {
                    Add-Content -LiteralPath $authorizedPath -Value $publicLine -Encoding ASCII
                }
                & (Join-Path $env:SystemRoot 'System32\icacls.exe') $authorizedPath /inheritance:r /grant:r 'SYSTEM:(F)' 'BUILTIN\Administrators:(F)' | Out-Null
            }
            Write-Log 'Host public key installed for SSH administration.'
        }

        $githubKeySource = Join-Path $share 'id_ed25519_github'
        if (Test-Path -LiteralPath $githubKeySource) {
            $githubKeyTarget = Join-Path $userSsh 'id_ed25519_github'
            Copy-Item -LiteralPath $githubKeySource -Destination $githubKeyTarget -Force
            & (Join-Path $env:SystemRoot 'System32\icacls.exe') $githubKeyTarget /inheritance:r /grant:r ($env:COMPUTERNAME + '\' + $guestUser + ':(F)') 'SYSTEM:(F)' | Out-Null
            Write-Log 'GitHub private key copied into VMUser SSH profile.'
        }
    }

    $sshdConfig = Join-Path $env:ProgramData 'ssh\sshd_config'
    if (Test-Path -LiteralPath $sshdConfig) {
        $configLines = @(Get-Content -LiteralPath $sshdConfig -ErrorAction SilentlyContinue)
        $seenPassword = $false
        $seenEmpty = $false
        $seenPubkey = $false
        $normalized = foreach ($line in $configLines) {
            if ($line -match '^\s*#?\s*PasswordAuthentication\s+') {
                $seenPassword = $true
                'PasswordAuthentication yes'
            } elseif ($line -match '^\s*#?\s*PermitEmptyPasswords\s+') {
                $seenEmpty = $true
                'PermitEmptyPasswords no'
            } elseif ($line -match '^\s*#?\s*PubkeyAuthentication\s+') {
                $seenPubkey = $true
                'PubkeyAuthentication yes'
            } else {
                $line
            }
        }
        if (-not $seenPassword) { $normalized += 'PasswordAuthentication yes' }
        if (-not $seenEmpty) { $normalized += 'PermitEmptyPasswords no' }
        if (-not $seenPubkey) { $normalized += 'PubkeyAuthentication yes' }
        Set-Content -LiteralPath $sshdConfig -Value $normalized -Encoding ASCII
    }

    $sshConfig = Join-Path $userSsh 'config'
    @(
        'Host github.com'
        '    HostName github.com'
        '    User git'
        '    IdentityFile C:/Users/VMUser/.ssh/id_ed25519_github'
        '    IdentitiesOnly yes'
        '    StrictHostKeyChecking accept-new'
    ) | Set-Content -LiteralPath $sshConfig -Encoding ASCII
    & (Join-Path $env:SystemRoot 'System32\icacls.exe') $sshConfig /inheritance:r /grant:r ($env:COMPUTERNAME + '\' + $guestUser + ':(F)') 'SYSTEM:(F)' | Out-Null

    $sshKeyscan = Get-Command ssh-keyscan.exe -ErrorAction SilentlyContinue
    if ($sshKeyscan) {
        $knownHostsPath = Join-Path $userSsh 'known_hosts'
        try {
            $scanInfo = New-Object System.Diagnostics.ProcessStartInfo
            $scanInfo.FileName = $sshKeyscan.Source
            $scanInfo.Arguments = '-H github.com'
            $scanInfo.UseShellExecute = $false
            $scanInfo.CreateNoWindow = $true
            $scanInfo.RedirectStandardOutput = $true
            $scanInfo.RedirectStandardError = $true
            $scanProcess = New-Object System.Diagnostics.Process
            $scanProcess.StartInfo = $scanInfo
            [void]$scanProcess.Start()
            $scanStdout = $scanProcess.StandardOutput.ReadToEnd()
            [void]$scanProcess.StandardError.ReadToEnd()
            $scanProcess.WaitForExit()
            $scanLines = @($scanStdout -split "`r?`n" | Where-Object {
                $_ -and $_ -notmatch '^\s*#'
            })
            if ($scanLines.Count -gt 0) {
                $scanLines | Set-Content -LiteralPath $knownHostsPath -Encoding ASCII
                Write-Log 'GitHub host keys saved to known_hosts.'
            } else {
                Write-Log ('ssh-keyscan returned no host keys (exit code ' + $scanProcess.ExitCode + '); continuing.')
            }
        } catch {
            Write-Log ('ssh-keyscan skipped: ' + $_.Exception.Message)
        }
    }

    Set-Service -Name sshd -StartupType Automatic -ErrorAction Stop
    Start-Service -Name sshd -ErrorAction SilentlyContinue
    Restart-Service -Name sshd -Force -ErrorAction SilentlyContinue
    $firewallRule = Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue
    if (-not $firewallRule) {
        New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Profile Any -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
    } else {
        Set-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -Enabled True -Profile Any -Direction Inbound -Protocol TCP -Action Allow | Out-Null
    }

    $gitPath = (Get-Command git.exe -ErrorAction SilentlyContinue).Source
    if (-not $gitPath) {
        $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
        if ($winget) {
            & $winget.Source install --id Git.Git --exact --source winget --accept-source-agreements --accept-package-agreements --silent
            $gitPath = (Get-Command git.exe -ErrorAction SilentlyContinue).Source
        }
    }
    if (-not $gitPath) {
        foreach ($candidate in @(
            'C:\Program Files\Git\cmd\git.exe',
            'C:\Program Files\Git\bin\git.exe'
        )) {
            if (Test-Path -LiteralPath $candidate) {
                $gitPath = $candidate
                break
            }
        }
    }
    if ($gitPath) {
        & $gitPath config --global core.sshCommand 'ssh -F C:/Users/VMUser/.ssh/config'
        Write-Log 'Git configured to use the VMUser SSH config.'
    } else {
        Write-Log 'Git executable was not found; SSH bootstrap completed.'
    }

    $ip = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
        Select-Object -ExpandProperty IPAddress -First 1
    Write-Log ('SSH ready. Guest IPv4=' + $ip)
    Write-Log 'Leave the temporary password in place until host-side SSH verification completes.'
} catch {
    Write-Log ('ERROR: ' + $_.Exception.Message)
    exit 1
}
