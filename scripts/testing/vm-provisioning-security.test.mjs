import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readWorkspaceFile(relativePath) {
  return readFileSync(path.join(workspaceRoot, relativePath), 'utf8');
}

const createVm = readWorkspaceFile('scripts/create-win11-vmware.js');
const primeExistingVm = readWorkspaceFile('scripts/prime-win11-ssh-git.ps1');
const primeExistingVmWrapper = readWorkspaceFile('scripts/prime-win11-ssh-git.cmd');
const repairNat = readWorkspaceFile('scripts/repair-vmware-nat.ps1');
const configureGitHub = readWorkspaceFile('scripts/configure-github-ssh-in-guest.ps1');
const provisioningSources = [
  createVm,
  primeExistingVm,
  primeExistingVmWrapper,
  repairNat,
  configureGitHub,
].join('\n');

test('VM provisioning contains no committed host path, private address, or named private key', () => {
  assert.doesNotMatch(provisioningSources, /[A-Za-z]:\\(?:VMs?|VMware|Downloads?)(?:\\|['"])/i);
  assert.doesNotMatch(repairNat, /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/);
  assert.doesNotMatch(provisioningSources, /\bid_(?:rsa|dsa|ecdsa|ed25519)(?:[_A-Za-z0-9.-]*)?\b/i);
  assert.doesNotMatch(provisioningSources, /^\s*IdentityFile\s+/im);
});

test('new VM creation requires operator-supplied paths, a process-only password, and a public key', () => {
  for (const environmentName of [
    'OMNI_VMWARE_DIR',
    'OMNI_VM_ROOT',
    'OMNI_WINDOWS_ISO',
    'OMNI_VM_AUTHORIZED_KEY_PATH',
    'OMNI_VM_GUEST_PASSWORD',
  ]) {
    assert.match(createVm, new RegExp(environmentName));
  }
  assert.match(createVm, /delete process\.env\.OMNI_VM_GUEST_PASSWORD/);
  assert.match(createVm, /xmlEscape\(guestPassword\)/);
  const unattendPasswordValues = [...createVm.matchAll(/<Password><Value>(.*?)<\/Value>/g)]
    .map((match) => match[1]);
  assert.deepEqual(unattendPasswordValues, ['${xmlEscape(guestPassword)}']);
  assert.doesNotMatch(primeExistingVm, /temporaryPassword|ConvertTo-SecureString\s+['"]/i);
  assert.match(createVm, /authorized_key\.pub/);
  assert.match(createVm, /fs\.mkdtempSync/);
  assert.match(createVm, /fs\.rmSync\(answerDir/);
  assert.match(createVm, /--cleanup-answer-media/);
});

test('new and existing VMs reject SSH passwords and limit the firewall rule', () => {
  const enabledValue = ['y', 'es'].join('');
  for (const source of [createVm, primeExistingVm]) {
    assert.match(source, /AuthenticationMethods publickey/);
    assert.match(source, /PubkeyAuthentication yes/);
    assert.match(source, /PasswordAuthentication no/);
    assert.match(source, /KbdInteractiveAuthentication no/);
    assert.match(source, /PermitEmptyPasswords no/);
    assert.doesNotMatch(source, new RegExp(`PasswordAuthentication ${enabledValue}`));
    assert.doesNotMatch(source, new RegExp(`PermitEmptyPasswords ${enabledValue}`));
    assert.match(source, /-Profile Private/);
    assert.match(source, /RemoteAddress/);
    assert.match(source, /Get-NetFirewallPortFilter\s+\|\s+Set-NetFirewallPortFilter\s+-Protocol TCP\s+-LocalPort 22/);
  }
  assert.match(createVm, /RemoteAddress LocalSubnet/);
  assert.match(primeExistingVm, /'LocalSubnet'/);
});

test('SSH hardening validates language-neutral ACLs and rolls back config or service failures', () => {
  for (const source of [createVm, primeExistingVm]) {
    assert.match(source, /function Invoke-CheckedNative/);
    assert.match(source, /\$global:LASTEXITCODE = \$null/);
    assert.match(source, /\$exitCode = \$global:LASTEXITCODE/);
    assert.match(source, /if \(\$null -eq \$exitCode\)/);
    assert.match(source, /if \(\$exitCode -ne 0\)/);
    assert.match(source, /S-1-5-18/);
    assert.match(source, /S-1-5-32-544/);
    assert.doesNotMatch(source, /['"]SYSTEM:\(/);
    assert.doesNotMatch(source, /BUILTIN\\Administrators:\(/);
    assert.match(source, /Assert-AuthorizedKeyAcl \$adminAuthorized/);
    assert.match(source, /\[System\.IO\.File\]::ReadAllBytes\(\$sshdConfig\)/);
    assert.match(source, /Restore-SshdConfigurationAndService \$sshdConfig \$configExisted \$previousConfig \$previousStartupType \$wasRunning/);
    assert.match(source, /the prior sshd_config and service state were restored/i);
    assert.match(source, /Restart-Service -Name sshd -Force -ErrorAction Stop/);
    assert.match(source, /Start-Service -Name sshd -ErrorAction Stop/);
    assert.doesNotMatch(source, /(?:Start|Restart)-Service\s+-Name\s+sshd[^\r\n]*SilentlyContinue/);

    const aclValidation = source.indexOf('Assert-AuthorizedKeyAcl $adminAuthorized');
    const publicKeyOnlyWrite = source.indexOf('Set-Content -LiteralPath $sshdConfig');
    assert.ok(aclValidation >= 0 && aclValidation < publicKeyOnlyWrite);

    const directNativeInvocations = [...source.matchAll(/^\s*&\s+([^\r\n]+)/gm)]
      .map((match) => match[1].trim());
    assert.deepEqual(directNativeInvocations, ['$FilePath @ArgumentList | Out-Null']);
  }

  assert.match(primeExistingVm, /Assert-AuthorizedKeyAcl \$userAuthorized/);
});

test('checked native invocation accepts zero, rejects nonzero, and rejects a missing executable', () => {
  const helperMatch = createVm.match(
    /function Invoke-CheckedNative[\s\S]*?\r?\n}\r?\n\r?\nfunction Assert-AuthorizedKeyAcl/,
  );
  assert.ok(helperMatch, 'embedded Invoke-CheckedNative helper should be extractable');
  const helper = helperMatch[0].replace(/\r?\nfunction Assert-AuthorizedKeyAcl$/, '');
  const probe = [
    "$ErrorActionPreference = 'Continue'",
    helper,
    "$command = Join-Path $env:SystemRoot 'System32\\cmd.exe'",
    "try { Invoke-CheckedNative $command @('/d', '/c', 'exit 0') 'zero' } catch { Write-Error ('zero: ' + $_.Exception.Message); exit 2 }",
    "$nonzeroRejected = $false",
    "try { Invoke-CheckedNative $command @('/d', '/c', 'exit 9') 'nonzero' } catch { $nonzeroRejected = $_.Exception.Message -match 'exit code 9' }",
    "if (-not $nonzeroRejected) { Write-Error 'nonzero exit was not rejected'; exit 3 }",
    "$missingRejected = $false",
    "try { Invoke-CheckedNative (Join-Path $env:TEMP 'omni-native-probe-missing.exe') @() 'missing' } catch { $missingRejected = $_.Exception.Message -match 'failed to start' }",
    "if (-not $missingRejected) { Write-Error 'missing executable was not rejected'; exit 4 }",
    'exit 0',
  ].join('\n');
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
    { input: probe, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('automatic logon and blank-password transitions cannot return', () => {
  assert.doesNotMatch(createVm, /<AutoLogon>/);
  assert.doesNotMatch(createVm, /Set-VMUserBlankPassword/);
  assert.doesNotMatch(createVm, /AutoAdminLogon'\s+-Value\s+'1'/);
  assert.doesNotMatch(createVm, /DefaultPassword'\s+-Value/);
  assert.match(createVm, /logonpasswordchg:yes/);
  assert.match(createVm, /AutoAdminLogon'\s+-Value\s+'0'/);

  assert.match(primeExistingVm, /Set-LocalUser\s+-Name\s+\$GuestUser\s+-Password\s+\$newPassword/);
  assert.match(primeExistingVm, /AutoAdminLogon'\s+-Value\s+'0'/);
  assert.match(primeExistingVm, /DefaultPassword/);
  assert.match(primeExistingVm, /Remove-ItemProperty\s+-Path\s+\$winlogon\s+-Name\s+\$propertyName/);
});

test('Git bootstrap never copies a private key into the guest', () => {
  assert.doesNotMatch(primeExistingVm, /IdentityFile|known_hosts|ssh-keyscan/i);
  assert.doesNotMatch(primeExistingVm, /Copy-Item[^\r\n]*(?:key|credential)/i);
  assert.doesNotMatch(configureGitHub, /IdentityFile|ssh-keygen|ssh-keyscan/i);
  assert.match(configureGitHub, /credential\.helper manager/);
  assert.match(configureGitHub, /https:\/\/github\.com\//);
});

test('NAT repair obtains environment-specific addresses from parameters or environment variables', () => {
  assert.match(repairNat, /\$GuestIp = \$env:OMNI_VM_GUEST_IP/);
  assert.match(repairNat, /\$GatewayIp = \$env:OMNI_VM_NAT_GATEWAY/);
  assert.match(repairNat, /Assert-IPv4Address \$GuestIp/);
  assert.match(repairNat, /Assert-IPv4Address \$GatewayIp/);
});
