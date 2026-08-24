'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

function fail(message) {
  throw new Error(message);
}

function optionValue(name, environmentName, { required = false, defaultValue = '' } = {}) {
  const optionIndex = process.argv.indexOf(name);
  if (optionIndex >= 0 && (!process.argv[optionIndex + 1] || process.argv[optionIndex + 1].startsWith('--'))) {
    fail(`${name} requires a value.`);
  }
  const option = optionIndex >= 0 ? process.argv[optionIndex + 1] : '';
  const value = option || process.env[environmentName] || defaultValue;
  if (required && !value) {
    fail(`Missing ${name}. Pass it explicitly or set ${environmentName}.`);
  }
  return value;
}

function resolvedOption(name, environmentName, options) {
  const value = optionValue(name, environmentName, options);
  return value ? path.resolve(value) : '';
}

function validateName(value, description) {
  if (!/^[A-Za-z0-9._ -]+$/.test(value)) {
    fail(`${description} contains unsupported characters.`);
  }
  return value;
}

function xmlEscape(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

if (process.argv.includes('--help')) {
  console.log([
    'Usage: node scripts/create-win11-vmware.js --vmware-dir <dir> --vm-root <dir> [options]',
    '',
    'Creation also requires --windows-iso <file>, --authorized-key <public-key-file>,',
    'and OMNI_VM_GUEST_PASSWORD in the process environment. Paths can instead use',
    'OMNI_VMWARE_DIR, OMNI_VM_ROOT, OMNI_WINDOWS_ISO, and OMNI_VM_AUTHORIZED_KEY_PATH.',
    'Use a unique one-time setup password; the script never prints it and Windows will',
    'require it to be changed after bootstrap completes.',
    '',
    'After Windows setup and a password change, power off the VM and run this command',
    'again with --cleanup-answer-media to detach and delete the credential-bearing ISO.',
  ].join('\n'));
  process.exit(0);
}

const startExistingRequested = process.argv.includes('--start-existing');
const cleanupRequested = process.argv.includes('--cleanup-answer-media');
const createRequested = !startExistingRequested && !cleanupRequested;

const vmwareDir = resolvedOption('--vmware-dir', 'OMNI_VMWARE_DIR', { required: true });
const vmrun = path.join(vmwareDir, 'vmrun.exe');
const vdiskManager = path.join(vmwareDir, 'vmware-vdiskmanager.exe');
const mkisofs = path.join(vmwareDir, 'mkisofs.exe');
const windowsToolsIso = resolvedOption('--tools-iso', 'OMNI_VMWARE_TOOLS_ISO', {
  defaultValue: path.join(vmwareDir, 'windows.iso'),
});
const windowsIso = resolvedOption('--windows-iso', 'OMNI_WINDOWS_ISO', {
  required: createRequested,
});
const authorizedKeyPath = resolvedOption('--authorized-key', 'OMNI_VM_AUTHORIZED_KEY_PATH', {
  required: createRequested,
});
const vmRoot = resolvedOption('--vm-root', 'OMNI_VM_ROOT', { required: true });
const vmName = validateName(
  optionValue('--vm-name', 'OMNI_VM_NAME', { defaultValue: 'Win11_Development_VM' }),
  'VM name',
);
const guestUser = validateName(
  optionValue('--guest-user', 'OMNI_VM_GUEST_USER', { defaultValue: 'VMUser' }),
  'Guest user name',
);
const guestPassword = createRequested ? process.env.OMNI_VM_GUEST_PASSWORD : '';
delete process.env.OMNI_VM_GUEST_PASSWORD;
if (createRequested && (!guestPassword || guestPassword.length < 14)) {
  fail('OMNI_VM_GUEST_PASSWORD must contain at least 14 characters. It is never accepted on the command line.');
}
const vmxPath = path.join(vmRoot, `${vmName}.vmx`);
const vmdkPath = path.join(vmRoot, `${vmName}.vmdk`);
const answerIso = path.join(vmRoot, `${vmName}-answer.iso`);
const hostShareDir = path.join(vmRoot, 'host-share');

function assertFile(filePath, description) {
  if (!fs.existsSync(filePath)) fail(`${description} not found: ${filePath}`);
}

function readAuthorizedKey(filePath) {
  assertFile(filePath, 'SSH public key');
  const publicKey = fs.readFileSync(filePath, 'utf8').trim();
  if (!/^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp(256|384|521))\s+[A-Za-z0-9+/=]+(?:\s+.*)?$/.test(publicKey)) {
    fail('The authorized-key file must contain exactly one supported OpenSSH public key.');
  }
  if (/\r|\n/.test(publicKey)) {
    fail('The authorized-key file must not contain multiple lines.');
  }
  return publicKey;
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd || vmRoot,
    encoding: 'utf8',
    stdio: options.stdio || 'inherit',
    windowsHide: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`${path.basename(executable)} failed with exit code ${result.status}`);
  }
  return result;
}

function startDetached(executable, args, cwd) {
  const child = spawn(executable, args, {
    cwd,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
}

function vmxPathValue(filePath) {
  return filePath.replaceAll('\\', '/');
}

function writeUtf8(filePath, content) {
  fs.writeFileSync(filePath, content, { encoding: 'utf8', flag: 'w' });
}

const bootKeyPs1 = String.raw`Add-Type -AssemblyName Microsoft.VisualBasic
Add-Type -AssemblyName System.Windows.Forms
Start-Sleep -Milliseconds 700
for ($i = 0; $i -lt 12; $i++) {
    $vmware = Get-Process -Name vmware -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowTitle -like '*${vmName}*' } |
        Select-Object -First 1
    if ($vmware) {
        try {
            [Microsoft.VisualBasic.Interaction]::AppActivate($vmware.Id) | Out-Null
            Start-Sleep -Milliseconds 120
            # VMware Workstation needs Ctrl+G to direct keyboard input to the guest display.
            [System.Windows.Forms.SendKeys]::SendWait('^g')
            Start-Sleep -Milliseconds 80
            [System.Windows.Forms.SendKeys]::SendWait(' ')
        } catch { }
    }
    Start-Sleep -Milliseconds 450
}
`;
const bootKeyPath = path.join(vmRoot, 'send-boot-key.ps1');

function sendBootKeySoon() {
  writeUtf8(bootKeyPath, bootKeyPs1);
  startDetached('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-WindowStyle',
    'Hidden',
    '-File',
    bootKeyPath,
  ], vmRoot);
}

const bootstrapPs1 = String.raw`# Windows guest bootstrap generated by create-win11-vmware.js.
$ErrorActionPreference = 'Continue'
$Base = 'C:\ProgramData\Win11VmBootstrap'
$Log = Join-Path $Base 'bootstrap.log'
$TaskName = 'Win11VmBootstrap'
$ScriptPath = Join-Path $Base 'bootstrap.ps1'
$GuestUser = '${guestUser}'
$Mutex = New-Object System.Threading.Mutex($false, 'Global\Win11VmBootstrapMutex')

New-Item -ItemType Directory -Path $Base -Force | Out-Null

function Log([string]$Message) {
    $line = ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message)
    Add-Content -LiteralPath $Log -Value $line -Encoding UTF8
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

function Publish-Log {
    $share = '\\vmware-host\Shared Folders\HostShare'
    if (Test-Path -LiteralPath $share) {
        try {
            Copy-Item -LiteralPath $Log -Destination (Join-Path $share 'bootstrap.log') -Force -ErrorAction Stop
            Log 'Bootstrap log copied to the VMware HostShare shared folder.'
        } catch {
            Log ('Unable to publish bootstrap log to HostShare: ' + $_.Exception.Message)
        }
    }
}

if (-not $Mutex.WaitOne(0)) {
    exit 0
}

function Done([string]$Name) {
    return Test-Path -LiteralPath (Join-Path $Base ($Name + '.done'))
}

function MarkDone([string]$Name) {
    New-Item -ItemType File -Path (Join-Path $Base ($Name + '.done')) -Force | Out-Null
}

function EnsureBootstrapTask {
    try {
        $action = New-ScheduledTaskAction -Execute 'PowerShell.exe' -Argument ('-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $ScriptPath + '"')
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User ($env:COMPUTERNAME + '\' + $GuestUser)
        $principal = New-ScheduledTaskPrincipal -UserId ($env:COMPUTERNAME + '\' + $GuestUser) -LogonType Interactive -RunLevel Highest
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
        Log 'Bootstrap scheduled task is installed.'
    } catch {
        Log ('Unable to register bootstrap task: ' + $_.Exception.Message)
        throw
    }
}

function RequestReboot([string]$Reason) {
    Log ('Reboot requested: ' + $Reason)
    Invoke-CheckedNative (Join-Path $env:SystemRoot 'System32\shutdown.exe') @(
        '/r', '/t', '30', '/c', ('Win11 VM bootstrap: ' + $Reason)
    ) 'Scheduling the bootstrap reboot'
    exit 0
}

function Install-WindowsUpdatesOnce {
    Log 'Starting one Windows Update scan/download/install cycle.'
    Set-Service -Name wuauserv -StartupType Manual -ErrorAction SilentlyContinue
    Start-Service -Name wuauserv -ErrorAction SilentlyContinue
    $session = New-Object -ComObject Microsoft.Update.Session
    $searcher = $session.CreateUpdateSearcher()
    $searchResult = $searcher.Search("IsInstalled=0 and IsHidden=0 and Type='Software'")
    $updates = New-Object -ComObject Microsoft.Update.UpdateColl
    foreach ($update in $searchResult.Updates) {
        if ($update.InstallationBehavior.CanRequestUserInput) {
            Log ('Skipping update that requests user input: ' + $update.Title)
            continue
        }
        if (-not $update.EulaAccepted) {
            $update.AcceptEula()
        }
        [void]$updates.Add($update)
    }
    if ($updates.Count -eq 0) {
        Log 'Windows Update found no applicable software updates.'
        return $false
    }
    Log ('Windows Update selected ' + $updates.Count + ' update(s).')
    $downloader = $session.CreateUpdateDownloader()
    $downloader.Updates = $updates
    $downloadResult = $downloader.Download()
    Log ('Windows Update download result: ' + $downloadResult.ResultCode)
    $installer = $session.CreateUpdateInstaller()
    $installer.Updates = $updates
    $installResult = $installer.Install()
    Log ('Windows Update install result: ' + $installResult.ResultCode)
    return [bool]$installResult.RebootRequired
}

function Install-VMwareTools {
    if (Get-Service -Name 'VMTools' -ErrorAction SilentlyContinue) {
        Log 'VMware Tools service is already installed; skipping the installer.'
        return $false
    }
    $setup = $null
    foreach ($drive in Get-PSDrive -PSProvider FileSystem) {
        foreach ($candidate in @('setup64.exe', 'setup.exe')) {
            $path = Join-Path $drive.Root $candidate
            if (Test-Path -LiteralPath $path) {
                $label = ''
                try { $label = (Get-Volume -DriveLetter $drive.Name -ErrorAction Stop).FileSystemLabel } catch { }
                if ($label -eq 'VMware Tools' -or (Test-Path (Join-Path $drive.Root 'manifest.txt'))) {
                    $setup = $path
                    break
                }
            }
        }
        if ($setup) { break }
    }
    if (-not $setup) {
        Log 'VMware Tools installer was not found on the mounted VMware Tools ISO.'
        return $false
    }
    Log ('Installing VMware Tools from ' + $setup)
    $p = Start-Process -FilePath $setup -ArgumentList @('/S', '/v"/qn REBOOT=ReallySuppress"') -Wait -PassThru -WindowStyle Hidden
    Log ('VMware Tools installer exit code: ' + $p.ExitCode)
    if ($p.ExitCode -notin @(0, 3010)) {
        throw ('VMware Tools installation failed with exit code ' + $p.ExitCode)
    }
    return $p.ExitCode -eq 3010
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

function Configure-OpenSSH {
    Log 'Installing and configuring OpenSSH for public-key-only access.'
    $client = Get-WindowsCapability -Online -Name 'OpenSSH.Client~~~~0.0.1.0' -ErrorAction SilentlyContinue
    if ($client -and $client.State -ne 'Installed') {
        Add-WindowsCapability -Online -Name 'OpenSSH.Client~~~~0.0.1.0' -ErrorAction Stop | Out-Null
    }
    $server = Get-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0' -ErrorAction SilentlyContinue
    $restartNeeded = $false
    if ($server -and $server.State -ne 'Installed') {
        $capResult = Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0' -ErrorAction Stop
        if ($capResult.RestartNeeded) { $restartNeeded = $true }
    }

    $authorizedKeySource = 'C:\Windows\Setup\Scripts\authorized_key.pub'
    if (-not (Test-Path -LiteralPath $authorizedKeySource -PathType Leaf)) {
        throw 'The required SSH public key was not copied from the answer media.'
    }
    $publicLine = (Get-Content -Raw -LiteralPath $authorizedKeySource).Trim()
    if ($publicLine -notmatch '^(ssh-(ed25519|rsa)|ecdsa-sha2-nistp(256|384|521))\s+[A-Za-z0-9+/=]+(?:\s+.*)?$') {
        throw 'The authorized key file does not contain one supported OpenSSH public key.'
    }
    $adminAuthorized = 'C:\ProgramData\ssh\administrators_authorized_keys'
    New-Item -ItemType Directory -Path (Split-Path -Parent $adminAuthorized) -Force | Out-Null
    $existingKeys = if (Test-Path -LiteralPath $adminAuthorized) {
        @(Get-Content -LiteralPath $adminAuthorized)
    } else {
        @()
    }
    if ($existingKeys -notcontains $publicLine) {
        Add-Content -LiteralPath $adminAuthorized -Value $publicLine -Encoding ASCII -ErrorAction Stop
    }
    $systemSid = 'S-1-5-18'
    $administratorsSid = 'S-1-5-32-544'
    Invoke-CheckedNative (Join-Path $env:SystemRoot 'System32\icacls.exe') @(
        $adminAuthorized,
        '/inheritance:r',
        '/grant:r',
        ('*' + $systemSid + ':(F)'),
        ('*' + $administratorsSid + ':(F)')
    ) 'Securing administrators_authorized_keys with icacls.exe'
    Assert-AuthorizedKeyAcl $adminAuthorized @($systemSid, $administratorsSid)

    $sshdConfig = 'C:\ProgramData\ssh\sshd_config'
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
        Log 'OpenSSH is running with public-key-only authentication.'
    } catch {
        $hardeningFailure = $_.Exception.Message
        try {
            Restore-SshdConfigurationAndService $sshdConfig $configExisted $previousConfig $previousStartupType $wasRunning
        } catch {
            throw ('SSH hardening failed: ' + $hardeningFailure + ' Rollback also failed: ' + $_.Exception.Message)
        }
        throw ('SSH hardening failed; the prior sshd_config and service state were restored: ' + $hardeningFailure)
    }

    $sshFirewallRule = Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue
    if (-not $sshFirewallRule) {
        $sshFirewallRule = New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Profile Private -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 -RemoteAddress LocalSubnet
    } else {
        Set-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -Enabled True -Profile Private -Direction Inbound -Action Allow -ErrorAction Stop
        $sshFirewallRule | Get-NetFirewallAddressFilter | Set-NetFirewallAddressFilter -RemoteAddress LocalSubnet | Out-Null
        $sshFirewallRule | Get-NetFirewallPortFilter | Set-NetFirewallPortFilter -Protocol TCP -LocalPort 22 | Out-Null
    }
    Log 'OpenSSH Server is limited to local-subnet clients on Private network profiles.'
    return $restartNeeded
}

function Get-WingetPath {
    $command = Get-Command winget.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $fallback = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\winget.exe'
    if (Test-Path -LiteralPath $fallback) { return $fallback }
    return $null
}

function Invoke-WingetInstall([string]$Id, [string]$Source, [string]$Winget) {
    $safeId = $Id -replace '[^A-Za-z0-9_.-]', '_'
    $stdout = Join-Path $Base ('winget-' + $safeId + '.out.log')
    $stderr = Join-Path $Base ('winget-' + $safeId + '.err.log')
    $arguments = @('install', '--id', $Id, '--exact', '--silent', '--disable-interactivity', '--accept-package-agreements', '--accept-source-agreements')
    if ($Source) { $arguments += @('--source', $Source) }
    Log ('Installing package ' + $Id + ' with WinGet.')
    $p = Start-Process -FilePath $Winget -ArgumentList $arguments -RedirectStandardOutput $stdout -RedirectStandardError $stderr -Wait -PassThru -WindowStyle Hidden
    if (Test-Path $stdout) { Get-Content -LiteralPath $stdout -ErrorAction SilentlyContinue | ForEach-Object { Log $_ } }
    if (Test-Path $stderr) { Get-Content -LiteralPath $stderr -ErrorAction SilentlyContinue | ForEach-Object { Log $_ } }
    Log ('WinGet exit code for ' + $Id + ': ' + $p.ExitCode)
    # WinGet returns this non-zero code when the requested package is already
    # installed and there is no newer version. Treat that idempotent outcome
    # as success so a rerun does not report healthy installs as failures.
    return $p.ExitCode -eq 0 -or $p.ExitCode -eq -1978335189
}

function Install-JetBrainsAir {
    $api = 'https://data.services.jetbrains.com/products/releases?code=AIR&latest=true&type=preview'
    $release = (Invoke-RestMethod -Uri $api -UseBasicParsing).AIR | Select-Object -First 1
    if (-not $release) {
        throw 'JetBrains Air latest release metadata was not available.'
    }
    $build = [string]$release.build
    $url = [string]$release.downloads.windows_x64.link
    $airRoot = Join-Path $env:LOCALAPPDATA ('Programs\JetBrains\Air-' + $build)
    $airExe = Join-Path $airRoot 'Air.exe'
    if (Test-Path -LiteralPath $airExe) {
        Log ('JetBrains Air ' + $build + ' is already installed at ' + $airRoot)
        return
    }
    $archive = Join-Path $env:TEMP ('JetBrains-Air-' + $build + '.zip')
    Log ('Downloading current JetBrains Air ' + $build + ' ZIP from the official JetBrains endpoint.')
    Invoke-WebRequest -Uri $url -OutFile $archive -UseBasicParsing
    New-Item -ItemType Directory -Path $airRoot -Force | Out-Null
    Invoke-CheckedNative (Join-Path $env:SystemRoot 'System32\tar.exe') @('-xf', $archive, '-C', $airRoot) 'Extracting the JetBrains Air archive'
    if (-not (Test-Path -LiteralPath $airExe)) {
        throw 'JetBrains Air ZIP installation did not produce Air.exe.'
    }
    $startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\JetBrains'
    New-Item -ItemType Directory -Path $startMenu -Force | Out-Null
    try {
        $shell = New-Object -ComObject WScript.Shell
        $link = $shell.CreateShortcut((Join-Path $startMenu 'JetBrains Air.lnk'))
        $link.TargetPath = $airExe
        $link.WorkingDirectory = $airRoot
        $link.IconLocation = $airExe + ',0'
        $link.Save()
    } catch {
        Log ('JetBrains Air shortcut creation warning: ' + $_.Exception.Message)
    }
    Log ('JetBrains Air ' + $build + ' installed at ' + $airRoot)
}

function Install-DeveloperApps {
    $winget = Get-WingetPath
    if (-not $winget) {
        Log 'WinGet is not available in this Windows image; skipping package installs and continuing with VM hardening.'
        return
    }
    $ok = $true
    $ok = (Invoke-WingetInstall 'Microsoft.VisualStudioCode.Insiders' 'winget' $winget) -and $ok
    $ok = (Invoke-WingetInstall 'OpenJS.NodeJS.LTS' 'winget' $winget) -and $ok
    $ok = (Invoke-WingetInstall '9PLM9XGG6VKS' 'msstore' $winget) -and $ok
    $airOk = $false
    try {
        Install-JetBrainsAir
        $airOk = $true
    } catch {
        Log ('JetBrains Air official ZIP installation failed: ' + $_.Exception.Message)
    }
    $ok = $airOk -and $ok
    if (-not $ok) {
        Log 'One or more developer application installations failed; continuing with the remaining VM hardening steps.'
    }
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    Log ('Node path: ' + $(if ($node) { $node.Source } else { 'not found in current PATH' }))
    Log ('npm path: ' + $(if ($npm) { $npm.Source } else { 'not found in current PATH' }))
}

function Disable-WindowsUpdates {
    Log 'Applying permanent Windows Update disable policies after the one-time update cycle.'
    $policy = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate'
    $au = Join-Path $policy 'AU'
    New-Item -Path $policy -Force | Out-Null
    New-Item -Path $au -Force | Out-Null
    New-ItemProperty -Path $au -Name 'NoAutoUpdate' -PropertyType DWord -Value 1 -Force | Out-Null
    New-ItemProperty -Path $au -Name 'AUOptions' -PropertyType DWord -Value 1 -Force | Out-Null
    New-ItemProperty -Path $au -Name 'NoAutoRebootWithLoggedOnUsers' -PropertyType DWord -Value 1 -Force | Out-Null
    New-ItemProperty -Path $policy -Name 'DisableWindowsUpdateAccess' -PropertyType DWord -Value 1 -Force | Out-Null
    New-ItemProperty -Path $policy -Name 'DoNotConnectToWindowsUpdateInternetLocations' -PropertyType DWord -Value 1 -Force | Out-Null
    foreach ($serviceName in @('wuauserv', 'UsoSvc')) {
        Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
        Set-Service -Name $serviceName -StartupType Disabled -ErrorAction SilentlyContinue
    }
    Log 'Windows Update policy and services are disabled. Re-enable the policy and services to update later.'
}

function Enforce-SecureLocalAccount {
    Log ('Enforcing password policy and disabling automatic logon for ' + $GuestUser + '.')
    $winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
    Set-ItemProperty -Path $winlogon -Name 'AutoAdminLogon' -Value '0' -ErrorAction Stop
    foreach ($propertyName in @('DefaultPassword', 'DefaultUserName', 'DefaultDomainName', 'AutoLogonCount')) {
        Remove-ItemProperty -Path $winlogon -Name $propertyName -ErrorAction SilentlyContinue
    }

    Set-LocalUser -Name $GuestUser -PasswordNeverExpires $false -ErrorAction Stop
    Invoke-CheckedNative (Join-Path $env:SystemRoot 'System32\net.exe') @(
        'user', $GuestUser, '/active:yes', '/passwordreq:yes'
    ) 'Enforcing the local account password policy'
    Invoke-CheckedNative (Join-Path $env:SystemRoot 'System32\net.exe') @(
        'user', $GuestUser, '/logonpasswordchg:yes'
    ) 'Requiring a password change at the next sign-in'

    Log 'Automatic logon is disabled and the setup password must be changed at the next sign-in.'
}

try {
    Log 'Bootstrap started.'
    if (-not (Test-Path -LiteralPath $ScriptPath)) {
        Copy-Item -LiteralPath $MyInvocation.MyCommand.Path -Destination $ScriptPath -Force
    }
    EnsureBootstrapTask

    if (-not (Done 'update')) {
        $reboot = Install-WindowsUpdatesOnce
        MarkDone 'update'
        if ($reboot) { RequestReboot 'Windows Update completed and requires a reboot' }
    }

    if (-not (Done 'tools')) {
        $reboot = Install-VMwareTools
        MarkDone 'tools'
        if ($reboot) { RequestReboot 'VMware Tools installation completed and requires a reboot' }
    }

    if (-not (Done 'ssh')) {
        $reboot = Configure-OpenSSH
        MarkDone 'ssh'
        if ($reboot) { RequestReboot 'OpenSSH capability installation completed and requires a reboot' }
    }

    if (-not (Done 'apps')) {
        Install-DeveloperApps
        MarkDone 'apps'
    }

    if (-not (Done 'updates-disabled')) {
        Disable-WindowsUpdates
        MarkDone 'updates-disabled'
    }

    Enforce-SecureLocalAccount
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Log 'Bootstrap completed with public-key-only SSH and automatic logon disabled.'
    Publish-Log
} catch {
    Log ('BOOTSTRAP ERROR: ' + $_.Exception.ToString())
    exit 1
} finally {
    try { $Mutex.ReleaseMutex() | Out-Null } catch { }
    $Mutex.Dispose()
}
`;

const unattendXml = String.raw`<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <settings pass="windowsPE">
    <component name="Microsoft-Windows-International-Core-WinPE" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <SetupUILanguage><UILanguage>zh-CN</UILanguage></SetupUILanguage>
      <InputLocale>zh-CN</InputLocale>
      <SystemLocale>zh-CN</SystemLocale>
      <UILanguage>zh-CN</UILanguage>
      <UserLocale>zh-CN</UserLocale>
    </component>
    <component name="Microsoft-Windows-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <DiskConfiguration>
        <Disk wcm:action="add">
          <DiskID>0</DiskID>
          <WillWipeDisk>true</WillWipeDisk>
          <CreatePartitions>
            <CreatePartition wcm:action="add"><Order>1</Order><Type>Primary</Type><Size>550</Size></CreatePartition>
            <CreatePartition wcm:action="add"><Order>2</Order><Type>Primary</Type><Extend>true</Extend></CreatePartition>
          </CreatePartitions>
          <ModifyPartitions>
            <ModifyPartition wcm:action="add"><Order>1</Order><PartitionID>1</PartitionID><Format>NTFS</Format><Label>System</Label><Letter>S</Letter><Active>true</Active></ModifyPartition>
            <ModifyPartition wcm:action="add"><Order>2</Order><PartitionID>2</PartitionID><Format>NTFS</Format><Label>Windows</Label><Letter>C</Letter></ModifyPartition>
          </ModifyPartitions>
        </Disk>
        <WillShowUI>Never</WillShowUI>
      </DiskConfiguration>
      <ImageInstall>
        <OSImage>
          <InstallFrom>
            <!-- This ISO has Windows 11 Pro at install.wim index 4. -->
            <MetaData wcm:action="add"><Key>/IMAGE/INDEX</Key><Value>4</Value></MetaData>
          </InstallFrom>
          <InstallTo><DiskID>0</DiskID><PartitionID>2</PartitionID></InstallTo>
          <WillShowUI>Never</WillShowUI>
        </OSImage>
      </ImageInstall>
      <UserData>
        <AcceptEula>true</AcceptEula>
        <ProductKey><Key>VK7JG-NPHTM-C97JM-9MPGT-3V66T</Key><WillShowUI>Never</WillShowUI></ProductKey>
      </UserData>
      <RunSynchronous>
        <RunSynchronousCommand wcm:action="add"><Order>1</Order><Path>cmd.exe /c reg add HKLM\SYSTEM\Setup\LabConfig /v BypassTPMCheck /t REG_DWORD /d 1 /f</Path></RunSynchronousCommand>
        <RunSynchronousCommand wcm:action="add"><Order>2</Order><Path>cmd.exe /c reg add HKLM\SYSTEM\Setup\LabConfig /v BypassSecureBootCheck /t REG_DWORD /d 1 /f</Path></RunSynchronousCommand>
        <RunSynchronousCommand wcm:action="add"><Order>3</Order><Path>cmd.exe /c reg add HKLM\SYSTEM\Setup\LabConfig /v BypassRAMCheck /t REG_DWORD /d 1 /f</Path></RunSynchronousCommand>
        <RunSynchronousCommand wcm:action="add"><Order>4</Order><Path>cmd.exe /c reg add HKLM\SYSTEM\Setup\LabConfig /v BypassCPUCheck /t REG_DWORD /d 1 /f</Path></RunSynchronousCommand>
        <RunSynchronousCommand wcm:action="add"><Order>5</Order><Path>cmd.exe /c reg add HKLM\SYSTEM\Setup\LabConfig /v BypassStorageCheck /t REG_DWORD /d 1 /f</Path></RunSynchronousCommand>
      </RunSynchronous>
    </component>
  </settings>
  <settings pass="specialize">
    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <ComputerName>WIN11-25H2</ComputerName>
      <TimeZone>China Standard Time</TimeZone>
    </component>
    <component name="Microsoft-Windows-Deployment" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <RunSynchronous>
        <RunSynchronousCommand wcm:action="add"><Order>1</Order><Path>cmd.exe /c md C:\Windows\Setup\Scripts</Path></RunSynchronousCommand>
        <RunSynchronousCommand wcm:action="add"><Order>2</Order><Path>cmd.exe /c for %D in (D E F G H I J K L M N O P Q R S T U V W X Y Z) do if exist %D:\bootstrap.ps1 copy /Y %D:\bootstrap.ps1 C:\Windows\Setup\Scripts\bootstrap.ps1</Path></RunSynchronousCommand>
        <RunSynchronousCommand wcm:action="add"><Order>3</Order><Path>cmd.exe /c for %D in (D E F G H I J K L M N O P Q R S T U V W X Y Z) do if exist %D:\authorized_key.pub copy /Y %D:\authorized_key.pub C:\Windows\Setup\Scripts\authorized_key.pub</Path></RunSynchronousCommand>
      </RunSynchronous>
    </component>
  </settings>
  <settings pass="oobeSystem">
    <component name="Microsoft-Windows-International-Core" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <InputLocale>zh-CN</InputLocale>
      <SystemLocale>zh-CN</SystemLocale>
      <UILanguage>zh-CN</UILanguage>
      <UserLocale>zh-CN</UserLocale>
    </component>
    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <OOBE>
        <HideEULAPage>true</HideEULAPage>
        <HideOnlineAccountScreens>true</HideOnlineAccountScreens>
        <HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE>
        <NetworkLocation>Work</NetworkLocation>
        <ProtectYourPC>3</ProtectYourPC>
        <SkipMachineOOBE>true</SkipMachineOOBE>
        <SkipUserOOBE>true</SkipUserOOBE>
      </OOBE>
      <UserAccounts>
        <LocalAccounts>
          <LocalAccount wcm:action="add">
            <Password><Value>${xmlEscape(guestPassword)}</Value><PlainText>true</PlainText></Password>
            <Description>Local administrator for the VMware guest</Description>
            <DisplayName>${xmlEscape(guestUser)}</DisplayName>
            <Group>Administrators</Group>
            <Name>${xmlEscape(guestUser)}</Name>
          </LocalAccount>
        </LocalAccounts>
      </UserAccounts>
      <RegisteredOwner>VM User</RegisteredOwner>
      <RegisteredOrganization>Local VMware VM</RegisteredOrganization>
      <FirstLogonCommands>
        <SynchronousCommand wcm:action="add">
          <Order>1</Order>
          <Description>Run VM bootstrap configuration</Description>
          <CommandLine>cmd.exe /c start "" powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\Windows\Setup\Scripts\bootstrap.ps1</CommandLine>
        </SynchronousCommand>
      </FirstLogonCommands>
    </component>
  </settings>
</unattend>
`;

function createVm() {
  assertFile(vmrun, 'vmrun');
  assertFile(vdiskManager, 'vmware-vdiskmanager');
  assertFile(mkisofs, 'mkisofs');
  assertFile(windowsToolsIso, 'VMware Tools ISO');
  assertFile(windowsIso, 'Windows ISO');
  const authorizedKey = readAuthorizedKey(authorizedKeyPath);

  if (fs.existsSync(vmRoot)) {
    const entries = fs.readdirSync(vmRoot);
    if (entries.length > 0) {
      fail(`VM directory already exists and is not empty: ${vmRoot}`);
    }
  } else {
    fs.mkdirSync(vmRoot, { recursive: true });
  }
  fs.mkdirSync(hostShareDir, { recursive: true });

  const answerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-win11-answer-'));
  try {
    writeUtf8(path.join(answerDir, 'autounattend.xml'), unattendXml);
    writeUtf8(path.join(answerDir, 'bootstrap.ps1'), bootstrapPs1);
    writeUtf8(path.join(answerDir, 'authorized_key.pub'), `${authorizedKey}\n`);
    run(mkisofs, ['-o', answerIso, '-V', 'WIN11AUTO', '-J', '-R', answerDir], { cwd: vmRoot });
  } finally {
    fs.rmSync(answerDir, { recursive: true, force: true });
  }
  run(vdiskManager, ['-c', '-s', '40GB', '-a', 'lsilogic', '-t', '0', vmdkPath], { cwd: vmRoot });

  const vmx = [
    '.encoding = "UTF-8"',
    'config.version = "8"',
    'virtualHW.version = "21"',
    `displayName = "${vmName}"`,
    'guestOS = "windows11-64"',
    'firmware = "bios"',
    'uefi.secureBoot.enabled = "FALSE"',
    'secureBoot.enabled = "FALSE"',
    'memsize = "8192"',
    'numvcpus = "4"',
    'cpuid.coresPerSocket = "2"',
    'mainMem.useNamedFile = "FALSE"',
    'ich7m.present = "TRUE"',
    'mks.enable3d = "FALSE"',
    'sata0.present = "TRUE"',
    'sata0:0.present = "TRUE"',
    `sata0:0.fileName = "${path.basename(vmdkPath)}"`,
    'sata0:0.deviceType = "disk"',
    'sata0:0.startConnected = "TRUE"',
    'ide1.present = "TRUE"',
    'ide1:0.present = "TRUE"',
    'ide1:0.deviceType = "cdrom-image"',
    `ide1:0.fileName = "${vmxPathValue(windowsIso)}"`,
    'ide1:0.startConnected = "TRUE"',
    'ide1:1.present = "TRUE"',
    'ide1:1.deviceType = "cdrom-image"',
    `ide1:1.fileName = "${vmxPathValue(answerIso)}"`,
    'ide1:1.startConnected = "TRUE"',
    'ide1:2.present = "TRUE"',
    'ide1:2.deviceType = "cdrom-image"',
    `ide1:2.fileName = "${vmxPathValue(windowsToolsIso)}"`,
    'ide1:2.startConnected = "TRUE"',
    'bios.bootOrder = "cdrom,hdd"',
    'pciBridge0.present = "TRUE"',
    'pciBridge4.present = "TRUE"',
    'pciBridge4.virtualDev = "pcieRootPort"',
    'pciBridge4.functions = "8"',
    'pciBridge5.present = "TRUE"',
    'pciBridge5.virtualDev = "pcieRootPort"',
    'pciBridge5.functions = "8"',
    'pciBridge6.present = "TRUE"',
    'pciBridge6.virtualDev = "pcieRootPort"',
    'pciBridge6.functions = "8"',
    'pciBridge7.present = "TRUE"',
    'pciBridge7.virtualDev = "pcieRootPort"',
    'pciBridge7.functions = "8"',
    'pciBridge0.pciSlotNumber = "17"',
    'pciBridge4.pciSlotNumber = "21"',
    'pciBridge5.pciSlotNumber = "22"',
    'pciBridge6.pciSlotNumber = "23"',
    'pciBridge7.pciSlotNumber = "24"',
    'sata0.pciSlotNumber = "36"',
    'ide1.pciSlotNumber = "33"',
    'ethernet0.present = "TRUE"',
    'ethernet0.connectionType = "nat"',
    'ethernet0.virtualDev = "e1000e"',
    'ethernet0.startConnected = "TRUE"',
    'ethernet0.addressType = "generated"',
    'ethernet0.pciSlotNumber = "160"',
    'usb.present = "FALSE"',
    'sound.present = "FALSE"',
    'svga.present = "TRUE"',
    'svga.autodetect = "TRUE"',
    'tools.syncTime = "TRUE"',
    'tools.upgrade.policy = "manual"',
    'isolation.tools.copy.disable = "FALSE"',
    'isolation.tools.paste.disable = "FALSE"',
    'isolation.tools.hgfs.disable = "FALSE"',
    'sharedFolder0.present = "TRUE"',
    'sharedFolder0.enabled = "TRUE"',
    'sharedFolder0.readAccess = "TRUE"',
    'sharedFolder0.writeAccess = "TRUE"',
    `sharedFolder0.hostPath = "${vmxPathValue(hostShareDir)}"`,
    'sharedFolder0.guestName = "HostShare"',
    'sharedFolder0.expiration = "never"',
    'sharedFolder.maxNum = "1"',
    '',
  ].join('\n');
  writeUtf8(vmxPath, vmx);

  console.log(`Created VM configuration: ${vmxPath}`);
  console.log('Disk: 40 GB, monolithicSparse (-t 0), single VMDK file');
  console.log(`Windows account: ${guestUser} (local administrator, password required, automatic logon disabled)`);
  console.log('Secure Boot: disabled; Windows 11 compatibility checks are bypassed in WinPE for this VM.');
  console.log('Starting the VM. Sign in manually once so the guest bootstrap can run.');
  startDetached(vmrun, ['-T', 'ws', 'start', vmxPath, 'gui'], vmRoot);
  sendBootKeySoon();
  console.log('VMware start command detached successfully.');
  console.log('VM started successfully. Bootstrap log will be inside the guest at C:\\ProgramData\\Win11VmBootstrap\\bootstrap.log.');
  console.log('After the required password change, power off the VM and run --cleanup-answer-media.');
}

function startExistingVm() {
  assertFile(vmrun, 'vmrun');
  assertFile(vmxPath, 'existing VMX');
  console.log(`Starting existing VM: ${vmxPath}`);
  startDetached(vmrun, ['-T', 'ws', 'start', vmxPath, 'gui'], vmRoot);
  sendBootKeySoon();
  console.log('VMware start command detached successfully.');
}

function cleanupAnswerMedia() {
  assertFile(vmrun, 'vmrun');
  assertFile(vmxPath, 'existing VMX');

  const running = run(vmrun, ['-T', 'ws', 'list'], { stdio: 'pipe' }).stdout || '';
  const normalizedVmxPath = path.resolve(vmxPath).toLowerCase();
  const runningVms = running.split(/\r?\n/).map((entry) => path.resolve(entry).toLowerCase());
  if (runningVms.includes(normalizedVmxPath)) {
    fail('Power off the VM before removing its answer media.');
  }

  let vmx = fs.readFileSync(vmxPath, 'utf8');
  const replacements = new Map([
    ['ide1:1.present', 'FALSE'],
    ['ide1:1.startConnected', 'FALSE'],
  ]);
  for (const [key, value] of replacements) {
    const pattern = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=.*$`, 'm');
    if (!pattern.test(vmx)) fail(`VMX does not contain the expected ${key} setting.`);
    vmx = vmx.replace(pattern, `${key} = "${value}"`);
  }
  writeUtf8(vmxPath, vmx);
  fs.rmSync(answerIso, { force: true });
  console.log('Answer media detached and deleted. The generated setup credential is no longer stored beside the VM.');
}

try {
  if (cleanupRequested) {
    cleanupAnswerMedia();
  } else if (startExistingRequested) {
    startExistingVm();
  } else {
    createVm();
  }
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
}
