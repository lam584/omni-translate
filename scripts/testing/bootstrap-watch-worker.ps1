[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory=$true)][ValidateSet('LockPrivateKeyAcl','RotateSshHostKey','InstallBootReadinessTask','RemoveBootReadinessTask','WriteBootReadiness')][string]$Action,
  [string]$PrivateKeyPath = 'E:\id_rsa',
  [string]$ReadinessRoot = 'C:\ProgramData\OmniTranslate\watch-worker-readiness'
)
$ErrorActionPreference = 'Stop'

function Assert-Administrator {
  $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'This action requires an elevated administrator process.' }
}

if ($Action -eq 'WriteBootReadiness') {
  Assert-Administrator
  New-Item -ItemType Directory -Path $ReadinessRoot -Force | Out-Null
  $bios = (Get-CimInstance Win32_ComputerSystemProduct).UUID
  $boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')
  $ips = @(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -like '192.168.40.*' } | ForEach-Object IPAddress)
  [ordered]@{schemaVersion='watch-worker-boot-readiness/v1';biosUuid=$bios;bootedAtUtc=$boot;ipv4=$ips;sshd=(Get-Service sshd).Status.ToString()} | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $ReadinessRoot 'readiness.json') -Encoding utf8
  Unregister-ScheduledTask -TaskName 'OmniTranslate-WatchWorker-OneShotReadiness' -Confirm:$false
  return
}

if ($Action -eq 'LockPrivateKeyAcl') {
  if (-not (Test-Path -LiteralPath $PrivateKeyPath -PathType Leaf)) { throw "Private key is missing: $PrivateKeyPath" }
  Assert-Administrator
  if ($PSCmdlet.ShouldProcess($PrivateKeyPath, 'replace ACL with owner, SYSTEM and Administrators only')) {
    & icacls.exe $PrivateKeyPath '/setowner' "$env:USERDOMAIN\$env:USERNAME" '/inheritance:r' '/remove:g' '*S-1-1-0' '*S-1-5-11' '*S-1-5-32-545' '/grant:r' "$env:USERDOMAIN\$env:USERNAME`:(R)" '*S-1-5-18:(F)' '*S-1-5-32-544:(F)' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "icacls failed with exit code $LASTEXITCODE" }
    $unexpected = (Get-Acl -LiteralPath $PrivateKeyPath).Access | Where-Object {
      $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -notin @(
        "$env:USERDOMAIN\$env:USERNAME", 'NT AUTHORITY\SYSTEM', 'BUILTIN\Administrators'
      )
    }
    if ($unexpected) { throw 'Private-key ACL still contains an unexpected allow entry.' }
  }
  return
}

Assert-Administrator
if ($Action -eq 'RotateSshHostKey') {
  $key = "$env:ProgramData\ssh\ssh_host_ed25519_key"
  $publicKey = "$key.pub"
  $backup = "$key.omni-backup-$(Get-Date -Format 'yyyyMMddHHmmss')"
  if (-not (Test-Path -LiteralPath $key -PathType Leaf)) { throw "OpenSSH ED25519 host key is missing: $key" }
  if ($PSCmdlet.ShouldProcess($key, 'back up and rotate the ED25519 SSH host key')) {
    Copy-Item -LiteralPath $key -Destination $backup -ErrorAction Stop
    if (Test-Path -LiteralPath $publicKey) { Copy-Item -LiteralPath $publicKey -Destination "$backup.pub" -ErrorAction Stop }
    try {
      Remove-Item -LiteralPath $key -Force
      if (Test-Path -LiteralPath $publicKey) { Remove-Item -LiteralPath $publicKey -Force }
      # Windows PowerShell 5 drops a native empty-string argument. Preserve the
      # explicit empty passphrase as a quoted native argument for ssh-keygen.
      & ssh-keygen.exe -q -t ed25519 -N '""' -f $key
      if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $key -PathType Leaf)) { throw 'ssh-keygen failed' }
      & icacls.exe $key '/setowner' '*S-1-5-32-544' | Out-Null
      if ($LASTEXITCODE -ne 0) { throw 'failed to set the new OpenSSH private host key owner' }
      & icacls.exe $key '/inheritance:r' '/remove:g' "$env:USERDOMAIN\$env:USERNAME" '*S-1-1-0' '*S-1-5-11' '*S-1-5-32-545' '/grant:r' '*S-1-5-18:(F)' '*S-1-5-32-544:(F)' | Out-Null
      if ($LASTEXITCODE -ne 0) { throw 'failed to secure the new OpenSSH private host key ACL' }
      Restart-Service -Name sshd -ErrorAction Stop
      (Get-Service -Name sshd).WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds(15))
      if ((Get-Service -Name sshd).Status -ne 'Running') { throw 'sshd did not reach Running after host-key rotation' }
    } catch {
      $rotationError = $_.Exception.Message
      Copy-Item -LiteralPath $backup -Destination $key -Force
      if (Test-Path -LiteralPath "$backup.pub") { Copy-Item -LiteralPath "$backup.pub" -Destination $publicKey -Force }
      try { Restart-Service -Name sshd -ErrorAction Stop } catch { throw "SSH host-key rotation failed, the backup was restored, but sshd restart also failed: $($_.Exception.Message)" }
      throw "SSH host-key rotation failed and the backup was restored: $rotationError"
    }
    Write-Output "backup=$backup"
    & ssh-keygen.exe -lf $publicKey -E sha256
  }
  return
}

$taskName = 'OmniTranslate-WatchWorker-OneShotReadiness'
if ($Action -eq 'RemoveBootReadinessTask') {
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
  return
}
if ($PSCmdlet.ShouldProcess($taskName, 'install one-shot SYSTEM boot readiness task')) {
  New-Item -ItemType Directory -Path $ReadinessRoot -Force | Out-Null
  $escapedScript = $PSCommandPath.Replace('"', '""')
  $escapedRoot = $ReadinessRoot.Replace('"', '""')
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$escapedScript`" -Action WriteBootReadiness -ReadinessRoot `"$escapedRoot`""
  $trigger = New-ScheduledTaskTrigger -AtStartup
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
}
