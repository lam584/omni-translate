import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { repoRoot } from '../lib/testing-common.mjs';

for (const mode of ['hang', 'parent-exit-inherit', 'parent-exit-ignore', 'fast-zero', 'fast-error']) {
test(`native finalizer custody: ${mode}, preserving diagnostics and same-name peer`,
  { skip: process.platform !== 'win32', timeout: 35000 }, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-finalizer-native-'));
    const quote = (value) => `'${value.replaceAll("'", "''")}'`;
    const modulePath = path.join(repoRoot, 'scripts/testing/lib/powershell/Omni.Testing.WatchMode.InteractiveFinalizer.psm1');
    const processModule = path.join(repoRoot, 'scripts/testing/lib/powershell/Omni.Testing.Process.psm1');
    const runner = path.join(root, 'runner.cjs');
    const request = path.join(root, 'child-pids.json');
    const inner = path.join(root, 'invoke.ps1');
    const guardian = path.join(root, 'guardian.ps1');
    fs.writeFileSync(runner, `const {spawn}=require('node:child_process');
const fs=require('node:fs');
const mode='${mode}';
const child=mode.startsWith('fast-')?null:spawn(process.execPath,['-e','setInterval(()=>{},1000)',process.argv[3]],{stdio:mode==='parent-exit-inherit'?'inherit':'ignore',windowsHide:true,detached:true});
fs.writeFileSync(process.argv[3],JSON.stringify({root:process.pid,child:child?.pid??0}));
console.log('finalizer-stdout-before-hang'); console.error('finalizer-stderr-before-hang');
if(mode==='hang')setInterval(()=>{},1000); else process.exit(mode==='fast-error'?7:0);
`, 'utf8');
    fs.writeFileSync(inner, `
$ErrorActionPreference='Stop'
Import-Module ${quote(modulePath)} -Force
$module=Get-Module Omni.Testing.WatchMode.InteractiveFinalizer
$watch=[Diagnostics.Stopwatch]::StartNew()
$message=$null; $result=$null
try { $result= & $module { param($w,$n,$r,$q,$fast)
  $original=Get-Command Get-OmniProcessIdentity -ErrorAction SilentlyContinue
  if ($fast -and $null -ne $original) {
    function Get-OmniProcessIdentity { param($ProcessId,$Ownership,$ProcessHandle)
      $null=$ProcessHandle.WaitForExit(3000)
      & $original -ProcessId $ProcessId -Ownership $Ownership -ProcessHandle $ProcessHandle
    }
  }
  $invoke=@{WorkspaceRoot=$w;NodeExecutable=$n;RunnerPath=$r;RequestPath=$q}
  if ((Get-Command Invoke-OmniInteractiveFinalizer).Parameters.ContainsKey('DeadlineUtc')) {$invoke.DeadlineUtc=[DateTime]::UtcNow.AddMilliseconds(1500)}
  Invoke-OmniInteractiveFinalizer @invoke
} ${quote(root)} ${quote(process.execPath)} ${quote(runner)} ${quote(request)} $${mode.startsWith('fast-') ? 'true' : 'false'} }
catch { $message=$_.Exception.Message }
[ordered]@{message=$message;result=$result;elapsedMs=$watch.ElapsedMilliseconds}|ConvertTo-Json -Compress -Depth 4
`, 'utf8');
    fs.writeFileSync(guardian, `
$ErrorActionPreference='Stop'
Import-Module ${quote(processModule)} -Force
$peer=New-Object Diagnostics.Process
$peer.StartInfo.FileName=${quote(process.execPath)}
$peer.StartInfo.Arguments='-e "setInterval(()=>{},1000)"'
$peer.StartInfo.UseShellExecute=$false; $peer.StartInfo.CreateNoWindow=$true
$null=$peer.Start()
$peerLease=Get-OmniProcessIdentity -ProcessId $peer.Id -ProcessHandle $peer
$owned=New-Object Diagnostics.Process
$owned.StartInfo.FileName=(Get-Command powershell.exe).Source
$owned.StartInfo.Arguments='-NoProfile -ExecutionPolicy Bypass -File "' + ${quote(inner)} + '"'
$owned.StartInfo.UseShellExecute=$false; $owned.StartInfo.CreateNoWindow=$true
$owned.StartInfo.RedirectStandardOutput=$true; $owned.StartInfo.RedirectStandardError=$true
$null=$owned.Start()
$lease=Get-OmniProcessIdentity -ProcessId $owned.Id -ProcessHandle $owned
$out=$owned.StandardOutput.ReadToEndAsync(); $err=$owned.StandardError.ReadToEndAsync()
$watchdog=$false
try {
  if (-not $owned.WaitForExit(9000)) { $watchdog=$true; Stop-OmniOwnedProcessTree -Lease $lease -WaitMilliseconds 3000 | Out-Null }
  $out.Wait(3000)|Out-Null; $err.Wait(3000)|Out-Null
  $ids=Get-Content -LiteralPath ${quote(request)} -Raw|ConvertFrom-Json
  [ordered]@{watchdog=$watchdog;output=$out.Result;stderr=$err.Result;
    rootAlive=[bool](Get-Process -Id $ids.root -ErrorAction SilentlyContinue);
    childAlive=($ids.child -gt 0 -and [bool](Get-Process -Id $ids.child -ErrorAction SilentlyContinue));
    peerAlive=(Test-OmniProcessIdentity -Lease $peerLease)}|ConvertTo-Json -Compress
} finally {
  if (-not $owned.HasExited) { Stop-OmniOwnedProcessTree -Lease $lease -WaitMilliseconds 3000 | Out-Null }
  # Red tests may expose an orphan. Reclaim only the exact fixture PID whose
  # command line contains this test's unique request path; never image names.
  if ($null -ne $ids -and $ids.child -gt 0) {
    $orphan=Get-Process -Id $ids.child -ErrorAction SilentlyContinue
    if ($orphan) {
      $identity=Get-CimInstance Win32_Process -Filter ('ProcessId=' + $ids.child)
      if (-not $identity.CommandLine.Contains(${quote(request)})) { throw 'fixture child identity mismatch' }
      $orphanLease=Get-OmniProcessIdentity -ProcessId $orphan.Id -ProcessHandle $orphan
      Stop-OmniOwnedProcessTree -Lease $orphanLease -WaitMilliseconds 3000 | Out-Null
      $orphan.Dispose()
    }
  }
  Stop-OmniOwnedProcessTree -Lease $peerLease -WaitMilliseconds 3000 | Out-Null
  $owned.Dispose(); $peer.Dispose()
}
`, 'utf8');
    try {
      const child = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', guardian],
        { encoding: 'utf8', timeout: 30000, windowsHide: true });
      assert.equal(child.status, 0, child.stderr);
      const result = JSON.parse(child.stdout.trim());
      assert.equal(result.rootAlive, false);
      assert.equal(result.childAlive, false);
      assert.equal(result.peerAlive, true, 'same-name external Node peer must survive');
      assert.equal(result.watchdog, false, 'finalizer must honor caller deadline without guardian rescue');
      const finalizer = JSON.parse(result.output.trim());
      if (mode === 'fast-zero') {
        assert.equal(finalizer.message, null);
        assert.equal(finalizer.result.exitCode, 0);
        assert.match(String(finalizer.result.output), /finalizer-stdout-before-hang/);
        assert.match(finalizer.result.stderr, /finalizer-stderr-before-hang/);
      } else {
        assert.match(finalizer.message, mode === 'fast-error' ? /exitCode=7/ : /timed out/i);
        assert.match(finalizer.message, /finalizer-stdout-before-hang/);
        assert.match(finalizer.message, /finalizer-stderr-before-hang/);
      }
      assert.ok(finalizer.elapsedMs < 8000, `elapsed=${finalizer.elapsedMs}`);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}
