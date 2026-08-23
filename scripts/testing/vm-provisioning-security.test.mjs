import assert from 'node:assert/strict';
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
