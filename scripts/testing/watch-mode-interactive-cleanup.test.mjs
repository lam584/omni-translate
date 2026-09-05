import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const modulePath = fileURLToPath(new URL('./lib/powershell/Omni.Testing.WatchMode.InteractiveCleanup.psm1', import.meta.url));
const utilityModulePath = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32/WindowsPowerShell/v1.0/Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1',
);
const psQuote = (value) => `'${value.replaceAll("'", "''")}'`;

for (const scenario of ['orphan', 'hash', 'root-hash', 'image-path', 'sid', 'session', 'bios', 'binding', 'authority', 'parent-generation', 'pid-generation', 'deadline']) {
  test(`interactive cleanup native identity: ${scenario}`, { skip: process.platform !== 'win32', timeout: 60000 }, () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'omni-cleanup-test-'));
    const childFile = path.join(directory, 'child.json');
    const parentScript = path.join(directory, 'parent.cjs');
    writeFileSync(parentScript, `const fs=require('node:fs');const cp=require('node:child_process');const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true,detached:true});fs.writeFileSync(${JSON.stringify(childFile)},JSON.stringify({pid:child.pid}));setInterval(()=>{},1000);`, 'utf8');
    const script = `
$ErrorActionPreference='Stop'
Import-Module ${psQuote(utilityModulePath)} -Force
Import-Module ${psQuote(modulePath)} -Force
$root=$null; $child=$null; $unrelated=$null
function Identity($p,$role,$parentPid,$parentStartedAt) {
  $cim=Get-CimInstance Win32_Process -Filter ('ProcessId='+$p.Id)
  $owner=Invoke-CimMethod -InputObject $cim -MethodName GetOwnerSid
  return [pscustomobject]@{pid=$p.Id;startedAt=$p.StartTime.ToUniversalTime().ToString('o');parentPid=$parentPid;parentStartedAt=$parentStartedAt;sessionId=$p.SessionId;ownerSid=$owner.Sid;imagePath=$p.Path;imageSha256=(Get-FileHash -LiteralPath $p.Path -Algorithm SHA256).Hash.ToLowerInvariant();role=$role}
}
try {
  $root=Start-Process -FilePath ${psQuote(process.execPath)} -ArgumentList ('"'+${psQuote(parentScript)}+'"') -WindowStyle Hidden -PassThru
  [void]$root.Handle
  $limit=[DateTime]::UtcNow.AddSeconds(10)
  while (-not (Test-Path -LiteralPath ${psQuote(childFile)})) { if ([DateTime]::UtcNow -gt $limit) {throw 'fixture child timeout'}; Start-Sleep -Milliseconds 20 }
  $child=[Diagnostics.Process]::GetProcessById([int](Get-Content -LiteralPath ${psQuote(childFile)} -Raw | ConvertFrom-Json).pid)
  [void]$child.Handle
  $unrelated=Start-Process -FilePath ${psQuote(process.execPath)} -ArgumentList '-e','"setInterval(()=>{},1000)"' -WindowStyle Hidden -PassThru
  [void]$unrelated.Handle
  $task=[Diagnostics.Process]::GetCurrentProcess()
  $r=Identity $root 'shard-node' $PID $task.StartTime.ToUniversalTime().ToString('o')
  $c=Identity $child 'bridge' $root.Id $r.startedAt
  $bios=[string](Get-CimInstance Win32_ComputerSystemProduct).UUID
  $binding=[pscustomobject]@{executionId='fixture';planDigest='plan';leaseId='lease';leaseDigest='digest';cellId='c01';workerId='fixture';vmIdentityDigest='vm';expectedUserSid=$r.ownerSid;expectedSessionId=$r.sessionId;expectedVmUuidBios=$bios}
  $launch=[ordered]@{schemaVersion=2;artifactKind='watch-mode-interactive-shard-launch-authority';actualVmUuidBios=$bios;ownerSid=$r.ownerSid;sessionId=$r.sessionId;nodeProcess=$r.PSObject.Copy();taskProcess=(Identity $task 'task' 0 $null);explorerProcess=@{pid=-1}}
  $authority=[ordered]@{schemaVersion=2;artifactKind='watch-mode-interactive-process-authority';passed=$true;errors=@();expectedOwnerSid=$r.ownerSid;expectedSessionId=$r.sessionId;processes=@($r,$c);processCount=2;rootProcessId=$r.pid}
  foreach ($field in @('executionId','planDigest','leaseId','leaseDigest','cellId','workerId','vmIdentityDigest')) {$launch[$field]=$binding.$field;$authority[$field]=$binding.$field}
  $deadline=[DateTime]::UtcNow.AddSeconds(20)
  switch (${psQuote(scenario)}) {
    'orphan' {$root.Kill();if(-not $root.WaitForExit(5000)){throw 'root exit timeout'};$child.Refresh();if($child.HasExited){throw 'fixture did not retain orphan'}}
    'hash' {$c.imageSha256=('0'*64)}
    'root-hash' {$r.imageSha256=('0'*64);$launch.nodeProcess.imageSha256=$r.imageSha256}
    'image-path' {$c.imagePath=Join-Path ${psQuote(directory)} 'wrong-node.exe'}
    'sid' {$c.ownerSid='S-1-5-21-999'}
    'session' {$c.sessionId=($c.sessionId+1)}
    'bios' {$binding.expectedVmUuidBios='00000000-0000-0000-0000-000000000000'}
    'binding' {$authority.cellId='c04'}
    'authority' {$authority.passed=$false}
    'parent-generation' {$c.parentStartedAt=([DateTime]::Parse($r.startedAt).AddSeconds(-1).ToString('o'))}
    'pid-generation' {$c.startedAt=([DateTime]::Parse($c.startedAt).AddSeconds(1).ToString('o'));$root.Kill();if(-not $root.WaitForExit(5000)){throw 'root exit timeout'}}
    'deadline' {$deadline=[DateTime]::UtcNow.AddSeconds(-1)}
  }
  $launchPath=Join-Path ${psQuote(directory)} 'launch.json';$authorityPath=Join-Path ${psQuote(directory)} 'authority.json'
  $launch | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $launchPath -Encoding UTF8
  $authority | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $authorityPath -Encoding UTF8
  $receipt=Stop-OmniInteractiveOwnedProcesses -LaunchPath $launchPath -ProcessAuthorityPath $authorityPath -ExpectedBinding $binding -DeadlineUtc $deadline
  $child.Refresh();$unrelated.Refresh();$root.Refresh()
  [pscustomobject]@{receipt=$receipt;childAlive=(-not $child.HasExited);unrelatedAlive=(-not $unrelated.HasExited);rootAlive=(-not $root.HasExited);sessionId=$r.sessionId} | ConvertTo-Json -Depth 12 -Compress
} finally {
  $cleanupFailed=$false
  foreach($p in @($child,$root,$unrelated)) {
    if($null -ne $p) {
      try {if(-not $p.HasExited){$p.Kill();if(-not $p.WaitForExit(5000)){$cleanupFailed=$true}}}
      catch {$cleanupFailed=$true}
      finally {$p.Dispose()}
    }
  }
  if($cleanupFailed){throw 'fixture owned-handle cleanup failed'}
}
`;
    try {
      const scriptPath = path.join(directory, 'fixture.ps1');
      writeFileSync(scriptPath, script, 'utf8');
      const result = spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], { encoding: 'utf8', timeout: 50000, windowsHide: true });
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      const output = JSON.parse(result.stdout.trim());
      assert.ok(output.sessionId > 0, 'fixture requires an interactive user session');
      assert.equal(output.unrelatedAlive, true, 'same-image unrelated process must survive');
      if (scenario === 'orphan') {
        assert.equal(output.receipt.passed, true, JSON.stringify(output.receipt));
        assert.equal(output.childAlive, false);
        assert.ok(output.receipt.processes.some((entry) => entry.terminated), JSON.stringify(output.receipt));
      } else if (scenario === 'pid-generation') {
        assert.equal(output.childAlive, true, 'a different PID generation must survive');
        assert.equal(output.receipt.passed, true, JSON.stringify(output.receipt));
        assert.ok(output.receipt.processes.some((entry) => entry.status === 'original-generation-ended'));
        assert.ok(output.receipt.processes.every((entry) => !entry.terminated));
      } else {
        assert.equal(output.childAlive, true, JSON.stringify(output.receipt));
        assert.equal(output.rootAlive, true, 'validate all identities before killing');
        assert.equal(output.receipt.passed, false);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
