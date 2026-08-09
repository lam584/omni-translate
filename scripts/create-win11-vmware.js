'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const vmwareDir = 'E:\\VMware';
const vmrun = path.join(vmwareDir, 'vmrun.exe');
const vdiskManager = path.join(vmwareDir, 'vmware-vdiskmanager.exe');
const mkisofs = path.join(vmwareDir, 'mkisofs.exe');
const windowsToolsIso = path.join(vmwareDir, 'windows.iso');
const windowsIso = 'E:\\DownLoads\\zh-cn_windows_11_consumer_editions_version_25h2_updated_june_2026_x64_dvd_2045a41c.iso';

const vmRootArgIndex = process.argv.indexOf('--vm-root');
const vmRoot = vmRootArgIndex >= 0 && process.argv[vmRootArgIndex + 1]
  ? process.argv[vmRootArgIndex + 1]
  : 'E:\\VMs\\Win11_25H2_2026';
const vmName = 'Win11_25H2_2026_LocalNoPassword';
const vmxPath = path.join(vmRoot, `${vmName}.vmx`);
const vmdkPath = path.join(vmRoot, `${vmName}.vmdk`);
const answerDir = path.join(vmRoot, 'answer-files');
const answerIso = path.join(vmRoot, `${vmName}-answer.iso`);
const hostShareDir = path.join(vmRoot, 'host-share');

function fail(message) {
  throw new Error(message);
}

function assertFile(filePath, description) {
  if (!fs.existsSync(filePath)) fail(`${description} not found: ${filePath}`);
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
        Where-Object { $_.MainWindowTitle -like '*Win11_25H2_2026_LocalNoPassword*' } |
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

const bootstrapPs1 = String.raw`# Windows guest bootstrap for the Win11_25H2_2026 VM.
$ErrorActionPreference = 'Continue'
$Base = 'C:\ProgramData\Win11VmBootstrap'
$Log = Join-Path $Base 'bootstrap.log'
$TaskName = 'Win11VmBootstrap'
$ScriptPath = Join-Path $Base 'bootstrap.ps1'
$Mutex = New-Object System.Threading.Mutex($false, 'Global\Win11VmBootstrapMutex')

New-Item -ItemType Directory -Path $Base -Force | Out-Null

function Log([string]$Message) {
    $line = ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message)
    Add-Content -LiteralPath $Log -Value $line -Encoding UTF8
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
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User ($env:COMPUTERNAME + '\VMUser')
        $principal = New-ScheduledTaskPrincipal -UserId ($env:COMPUTERNAME + '\VMUser') -LogonType Interactive -RunLevel Highest
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
        Log 'Bootstrap scheduled task is installed.'
    } catch {
        Log ('Unable to register bootstrap task: ' + $_.Exception.Message)
        throw
    }
}

function RequestReboot([string]$Reason) {
    Log ('Reboot requested: ' + $Reason)
    shutdown.exe /r /t 30 /c ('Win11 VM bootstrap: ' + $Reason) | Out-Null
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

function Configure-OpenSSH {
    Log 'Installing and configuring OpenSSH Client and Server.'
    $client = Get-WindowsCapability -Online -Name 'OpenSSH.Client~~~~0.0.1.0' -ErrorAction SilentlyContinue
    if ($client -and $client.State -ne 'Installed') {
        Add-WindowsCapability -Online -Name 'OpenSSH.Client~~~~0.0.1.0' | Out-Null
    }
    $server = Get-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0' -ErrorAction SilentlyContinue
    $restartNeeded = $false
    if ($server -and $server.State -ne 'Installed') {
        $capResult = Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0'
        if ($capResult.RestartNeeded) { $restartNeeded = $true }
    }
    $sshdConfig = 'C:\ProgramData\ssh\sshd_config'
    if (Test-Path -LiteralPath $sshdConfig) {
        $configLines = @(Get-Content -LiteralPath $sshdConfig -ErrorAction SilentlyContinue)
        $configLines = @($configLines | ForEach-Object {
            if ($_ -match '^\s*#?\s*PermitEmptyPasswords\s+') {
                'PermitEmptyPasswords yes'
            } elseif ($_ -match '^\s*#?\s*PasswordAuthentication\s+') {
                'PasswordAuthentication yes'
            } else {
                $_
            }
        })
        if (-not ($configLines -match '^PermitEmptyPasswords\s+yes$')) {
            $configLines += 'PermitEmptyPasswords yes'
        }
        if (-not ($configLines -match '^PasswordAuthentication\s+yes$')) {
            $configLines += 'PasswordAuthentication yes'
        }
        Set-Content -LiteralPath $sshdConfig -Value $configLines -Encoding UTF8
        Log 'sshd_config allows password authentication with the requested empty-password local account.'
    }
    Set-Service -Name sshd -StartupType Automatic -ErrorAction Stop
    Start-Service -Name sshd -ErrorAction SilentlyContinue
    Restart-Service -Name sshd -Force -ErrorAction SilentlyContinue
    $sshFirewallRule = Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue
    if (-not $sshFirewallRule) {
        New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -DisplayName 'OpenSSH Server (sshd)' -Enabled True -Profile Any -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
    } else {
        Set-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -Enabled True -Profile Any -Direction Inbound -Action Allow -ErrorAction SilentlyContinue
    }
    Log 'OpenSSH Server is configured to start automatically and TCP/22 is allowed.'
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
    & "$env:SystemRoot\System32\tar.exe" -xf $archive -C $airRoot
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0 -or -not (Test-Path -LiteralPath $airExe)) {
        throw ('JetBrains Air ZIP installation failed with exit code ' + $exitCode)
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

function Set-VMUserBlankPassword {
    Log 'Clearing the temporary setup password from VMUser.'
    # Passing an empty native argument through cmd.exe is unreliable here. Use
    # the LocalAccounts API with an actual empty SecureString instead. The
    # PasswordRequired property is a policy flag and does not prove whether a
    # particular local account currently has a password, so do not use it as a
    # postcondition.
    $emptyPassword = New-Object System.Security.SecureString
    Set-LocalUser -Name VMUser -Password $emptyPassword -ErrorAction Stop
    & (Join-Path $env:SystemRoot 'System32\net.exe') user VMUser /active:yes | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw ('Unable to activate VMUser after clearing its password; net.exe exit code ' + $LASTEXITCODE)
    }
    Log 'VMUser now has an empty password.'
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

    Set-VMUserBlankPassword

    $winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
    Set-ItemProperty -Path $winlogon -Name 'AutoAdminLogon' -Value '1'
    Set-ItemProperty -Path $winlogon -Name 'DefaultUserName' -Value 'VMUser'
    Set-ItemProperty -Path $winlogon -Name 'DefaultDomainName' -Value $env:COMPUTERNAME
    Set-ItemProperty -Path $winlogon -Name 'DefaultPassword' -Value ''
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Log 'Bootstrap completed. VMUser remains a local administrator with an empty password and automatic logon enabled.'
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
      <AutoLogon>
        <Enabled>true</Enabled>
        <LogonCount>999</LogonCount>
        <Username>VMUser</Username>
        <Password><Value>VmSetup!2026</Value><PlainText>true</PlainText></Password>
      </AutoLogon>
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
            <Password><Value>VmSetup!2026</Value><PlainText>true</PlainText></Password>
            <Description>Local administrator for the VMware guest</Description>
            <DisplayName>VM User</DisplayName>
            <Group>Administrators</Group>
            <Name>VMUser</Name>
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

  if (fs.existsSync(vmRoot)) {
    const entries = fs.readdirSync(vmRoot);
    if (entries.length > 0) {
      fail(`VM directory already exists and is not empty: ${vmRoot}`);
    }
  } else {
    fs.mkdirSync(vmRoot, { recursive: true });
  }
  fs.mkdirSync(answerDir, { recursive: true });
  fs.mkdirSync(hostShareDir, { recursive: true });

  writeUtf8(path.join(answerDir, 'autounattend.xml'), unattendXml);
  writeUtf8(path.join(answerDir, 'bootstrap.ps1'), bootstrapPs1);

  run(mkisofs, ['-o', answerIso, '-V', 'WIN11AUTO', '-J', '-R', answerDir], { cwd: vmRoot });
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
  console.log('Windows account: VMUser (local administrator, empty password, automatic logon)');
  console.log('Secure Boot: disabled; Windows 11 compatibility checks are bypassed in WinPE for this VM.');
  console.log('Starting the VM. Guest bootstrap will continue after Windows first logon.');
  startDetached(vmrun, ['-T', 'ws', 'start', vmxPath, 'gui'], vmRoot);
  sendBootKeySoon();
  console.log('VMware start command detached successfully.');
  console.log('VM started successfully. Bootstrap log will be inside the guest at C:\\ProgramData\\Win11VmBootstrap\\bootstrap.log.');
}

function startExistingVm() {
  assertFile(vmxPath, 'existing VMX');
  console.log(`Starting existing VM: ${vmxPath}`);
  startDetached(vmrun, ['-T', 'ws', 'start', vmxPath, 'gui'], vmRoot);
  sendBootKeySoon();
  console.log('VMware start command detached successfully.');
}

try {
  if (process.argv.includes('--start-existing')) {
    startExistingVm();
  } else {
    createVm();
  }
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
}
