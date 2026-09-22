import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const jobModule = path.join(here, 'lib/powershell/Omni.Testing.WatchMode.InteractiveJob.psm1');
const cleanupModule = path.join(here, 'lib/powershell/Omni.Testing.WatchMode.InteractiveCleanup.psm1');
const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('fixture timeout: ' + label);
    await sleep(20);
  }
}
function powershell(script) {
  const utility = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1');
  script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=New-Object Text.UTF8Encoding($false); Import-Module " + quote(utility) + " -Force; " + script;
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.on('data', (bytes) => { stdout += bytes; });
  child.stderr.on('data', (bytes) => { stderr += bytes; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
  return { child, done };
}
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const common = String.raw`
$ErrorActionPreference='Stop'
Import-Module ${quote(jobModule)} -Force
Import-Module ${quote(cleanupModule)} -Force
Import-Module ${quote(path.join(here, 'lib/powershell/Omni.Testing.IO.psm1'))} -Force
function Identity($id,$parent,$imagePath) {
  $p=Get-Process -Id $id -ErrorAction Stop
  $c=Get-CimInstance Win32_Process -Filter ('ProcessId='+$id)
  $sid=Invoke-CimMethod -InputObject $c -MethodName GetOwnerSid
  if (-not $imagePath) { $imagePath=$p.Path }
  return [pscustomobject]@{pid=$id;parentPid=$parent;startedAt=$p.StartTime.ToUniversalTime().ToString('o');sessionId=$p.SessionId;ownerSid=$sid.Sid;imagePath=$imagePath;imageSha256=(Get-FileHash -LiteralPath $imagePath -Algorithm SHA256).Hash.ToLowerInvariant()}
}
`;
test('production launcher keeps shared IO commands visible after nested Force imports', { skip: process.platform !== 'win32', timeout: 35000 }, async () => {
  const launcher = fs.readFileSync(path.join(here, 'run-watch-mode-interactive-task.ps1'), 'utf8');
  const imports = launcher.split(/\r?\n/u).filter((line) => line.startsWith('Import-Module ')).slice(0, 4)
    .map((line) => line.replaceAll('$PSScriptRoot', quote(here)));
  assert.match(imports.at(-1), /Omni\.Testing\.IO\.psm1/u);
  const result = await powershell(`${imports.join('; ')}; [ordered]@{
    sha=[bool](Get-Command Get-OmniSha256 -ErrorAction SilentlyContinue)
    json=[bool](Get-Command Write-OmniJsonAtomic -ErrorAction SilentlyContinue)
  } | ConvertTo-Json -Compress`).done;
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.split(/\r?\n/u).at(-1)), { sha: true, json: true });
});
async function fixture(mode) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-job-native-'));
  const file = (name) => path.join(directory, name);
  const runner = file('runner.cjs');
  fs.writeFileSync(runner, `const fs=require('node:fs'),cp=require('node:child_process');
const out=process.argv[2],mode=process.argv[3];
fs.writeFileSync(out+'.executed','yes');
const child=cp.spawn(process.execPath,['-e',mode==='natural'?'setTimeout(()=>{},500)':'setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
fs.writeFileSync(out,JSON.stringify({root:process.pid,child:child.pid}));
if(mode==='natural')process.exit(0);else setInterval(()=>{},1000);
`, 'utf8');
  const ownerScript = file('owner.ps1');
  const launcher = fs.readFileSync(path.join(here, 'run-watch-mode-interactive-task.ps1'), 'utf8');
  const finalizeStart = launcher.lastIndexOf('} catch {\n  $launcherFailure = $_');
  assert.ok(finalizeStart > 0);
  const finalize = launcher.slice(finalizeStart, launcher.lastIndexOf('exit $nodeExitCode'));
  fs.writeFileSync(ownerScript, common + String.raw`
$w=${quote(directory)}; $mode=${quote(mode)}
$launchPath=Join-Path $w 'launch.json'
$task=Identity $PID 0
$binding=[ordered]@{executionId='fixture';planDigest=('1'*64);leaseId='lease';leaseDigest=('2'*64);cellId='c01';workerId='local';vmIdentityDigest=('3'*64);expectedUserSid=$task.ownerSid;expectedSessionId=$task.sessionId;expectedVmUuidBios=[string](Get-CimInstance Win32_ComputerSystemProduct).UUID}
$command=[ordered]@{schemaVersion=2;artifactKind='watch-mode-interactive-task-command';mode='shard-cell';launchPath=$launchPath}
foreach($key in $binding.Keys){$command[$key]=$binding[$key]}
Write-OmniImmutableJson -LiteralPath (Join-Path $w 'binding.json') -Value $binding
Write-OmniImmutableJson -LiteralPath (Join-Path $w 'command.json') -Value $command
$node=$null; $jobBinding=$null; $jobCleanupAcknowledged=$false
$launcherFailure=$null; $jobCleanupFailure=$null; $request=$command
try {
  $cancelBinding=Get-OmniInteractiveCancellationBinding $launchPath $binding
  if($mode -eq 'before-launch') {
    $limit=[DateTime]::UtcNow.AddSeconds(12)
    while(-not (Test-OmniInteractiveCancellationIntent $launchPath $cancelBinding)) { if([DateTime]::UtcNow -ge $limit){throw 'fixture early intent timeout'}; Start-Sleep -Milliseconds 20 }
  }
  if(Test-OmniInteractiveCancellationIntent $launchPath $cancelBinding) {
    Write-OmniInteractiveNotStartedAcknowledgment $launchPath $cancelBinding
  } else {
    $node=New-OmniInteractiveJob -Executable ${quote(process.execPath)} -Arguments @(${quote(runner)},(Join-Path $w 'ids.json'),$mode) -WorkingDirectory $w -StdoutPath (Join-Path $w 'stdout.log') -StderrPath (Join-Path $w 'stderr.log')
    $root=Identity $node.Id $PID ${quote(process.execPath)}
    Write-OmniImmutableJson -LiteralPath (Join-Path $w 'root.json') -Value $root
    if($mode -eq 'setup-error'){throw 'injected setup failure before normal loop'}
    $launch=[ordered]@{schemaVersion=2;artifactKind='watch-mode-interactive-shard-launch-authority';actualVmUuidBios=$binding.expectedVmUuidBios;ownerSid=$task.ownerSid;sessionId=$task.sessionId;nodeProcess=$root;taskProcess=$task;jobCustody=@{schemaVersion=1;kind='unnamed-kill-on-close-job';custodyId=[guid]::NewGuid().ToString('N')};commandSha256=(Get-FileHash -LiteralPath (Join-Path $w 'command.json') -Algorithm SHA256).Hash.ToLowerInvariant()}
    foreach($key in @('executionId','planDigest','leaseId','leaseDigest','cellId','workerId','vmIdentityDigest')){$launch[$key]=$binding[$key]}
    if($mode -eq 'binding-invalid'){$launch.leaseDigest='invalid-committed-binding'}
    Write-OmniImmutableJson -LiteralPath $launchPath -Value $launch
    if($mode -in @('binding-transient','binding-invalid')) {
      & (Get-Module Omni.Testing.WatchMode.InteractiveCleanup) {
        param($launchPath,$expected,$counterPath,$transient,$ownedJob)
        $script:originalBinding=(Get-Command Get-OmniInteractiveJobBinding).ScriptBlock
        $script:bindingCalls=0; $script:bindingCounterPath=$counterPath; $script:injectTransient=$transient; $script:revalidationJob=$ownedJob
        function script:Get-OmniInteractiveJobBinding {
          param($LaunchPath,$ExpectedBinding)
          $script:bindingCalls++
          [IO.File]::WriteAllText($script:bindingCounterPath,[string]$script:bindingCalls)
          if($script:bindingCalls -eq 1 -and $script:injectTransient){throw 'injected transient post-publication binding failure'}
          if($script:bindingCalls -gt 1 -and ($script:revalidationJob.ActiveProcesses -ne 0 -or -not $script:revalidationJob.HasExited)){throw 'revalidation preceded job drain'}
          & $script:originalBinding -LaunchPath $LaunchPath -ExpectedBinding $ExpectedBinding
        }
        Get-OmniInteractiveJobBinding $launchPath $expected
      } $launchPath $binding (Join-Path $w 'binding-attempts.txt') ($mode -eq 'binding-transient') $node
      throw 'fixture expected initial binding failure'
    }
    $jobBinding=Get-OmniInteractiveJobBinding $launchPath $binding
    if($mode -eq 'collector-error'){throw 'injected collector readiness failure'}
    if($mode -ne 'pre-release'){$node.Resume()}
    $cancelled=$false; $limit=[DateTime]::UtcNow.AddSeconds(18)
    while($node.ActiveProcesses -ne 0 -or -not $node.HasExited) {
      if([DateTime]::UtcNow -ge $limit){throw 'fixture watchdog'}
      if($mode -ne 'no-ack' -or (Test-Path -LiteralPath (Join-Path $w 'allow-cancel'))) {
        if(Receive-OmniInteractiveJobCancellation $node $launchPath $jobBinding){$cancelled=$true}
      }
      Start-Sleep -Milliseconds 20
    }
    Write-OmniInteractiveJobAcknowledgment $node $launchPath $jobBinding $cancelled
    $jobCleanupAcknowledged=$true
    # Collector evidence remains absent: acknowledgment must not depend on it.
    Write-OmniImmutableJson -LiteralPath (Join-Path $w 'after-ack.json') -Value @{terminalAuthorityPresent=(Test-Path -LiteralPath (Join-Path $w 'process-authority.json'))}
  }
${finalize}
`, 'utf8');
  const owner = powershell('& ' + quote(ownerScript));
  let startupResult;
  void owner.done.then((result) => { startupResult = result; });
  try {
    await until(() => {
      if (startupResult && !fs.existsSync(file('command.json'))) throw new Error('owner startup: ' + startupResult.stderr);
      return fs.existsSync(file('command.json'));
    }, 'command');
  } catch (error) { owner.child.kill(); await owner.done; fs.rmSync(directory, { recursive: true, force: true }); throw error; }
  return { directory, file, owner };
}
async function cancel(f, { milliseconds = 7000, mutate = '' } = {}) {
  const script = `$ErrorActionPreference='Stop'; Import-Module ${quote(cleanupModule)} -Force;
$b=Get-Content -LiteralPath ${quote(f.file('binding.json'))} -Raw|ConvertFrom-Json; ${mutate}
$watch=[Diagnostics.Stopwatch]::StartNew(); $r=Stop-OmniInteractiveOwnedProcesses -LaunchPath ${quote(f.file('launch.json'))} -ProcessAuthorityPath ${quote(f.file('process-authority.json'))} -ExpectedBinding $b -DeadlineUtc ([DateTime]::UtcNow.AddMilliseconds(${milliseconds}));
[ordered]@{receipt=$r;elapsedMs=$watch.ElapsedMilliseconds}|ConvertTo-Json -Compress -Depth 8`;
  const result = await powershell(script).done;
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}
async function requestOnly(f) {
  // Seed intent explicitly: a short no-ack deadline must not also assume that
  // cold CIM binding validation has already finished before that deadline.
  const result = await powershell(`$ErrorActionPreference='Stop'; Import-Module ${quote(cleanupModule)} -Force;
$b=Get-Content -LiteralPath ${quote(f.file('binding.json'))} -Raw|ConvertFrom-Json;
$binding=Get-OmniInteractiveCancellationBinding -LaunchPath ${quote(f.file('launch.json'))} -ExpectedBinding $b;
Request-OmniInteractiveJobCancellation -LaunchPath ${quote(f.file('launch.json'))} -Binding $binding`).done;
  assert.equal(result.code, 0, result.stderr);
}
async function assertEnded(f) {
  if (!fs.existsSync(f.file('root.json'))) return;
  const result = await powershell(`$ErrorActionPreference='Stop'; $r=Get-Content -LiteralPath ${quote(f.file('root.json'))} -Raw|ConvertFrom-Json; $p=Get-Process -Id $r.pid -ErrorAction SilentlyContinue; if($p -and $p.StartTime.ToUniversalTime().ToString('o') -ceq $r.startedAt -and -not $p.WaitForExit(4000)){throw 'fixture root generation survived'}; if(Test-Path -LiteralPath ${quote(f.file('ids.json'))}){$ids=Get-Content -LiteralPath ${quote(f.file('ids.json'))} -Raw|ConvertFrom-Json; $child=Get-Process -Id $ids.child -ErrorAction SilentlyContinue; if($child -and -not $child.WaitForExit(4000)){throw 'fixture child survived'}}; 'ended'`).done;
  assert.equal(result.code, 0, result.stderr);
}
async function finish(f) {
  if (f.owner.child.exitCode === null && f.owner.child.signalCode === null) f.owner.child.kill();
  await f.owner.done;
  await assertEnded(f);
  fs.rmSync(f.directory, { recursive: true, force: true });
}
const native = { skip: process.platform !== 'win32', timeout: 35000 };
for (const mode of ['before-launch', 'pre-release', 'active', 'natural', 'setup-error', 'collector-error', 'binding-transient', 'binding-invalid', 'launcher-exit']) {
  test('interactive private job native: ' + mode, native, async () => {
    const f = await fixture(mode);
    try {
      if (mode === 'binding-transient' || mode === 'binding-invalid') {
        const result = await f.owner.done;
        assert.notEqual(result.code, 0);
        assert.match(result.stderr, mode === 'binding-transient' ? /injected transient post-publication binding failure/ : /binding mismatch/);
        assert.equal(fs.readFileSync(f.file('binding-attempts.txt'), 'utf8'), '2', 'exactly one post-drain revalidation');
        assert.equal(fs.existsSync(f.file('cleanup.job.json')), mode === 'binding-transient');
        if (mode === 'binding-transient') assert.equal(read(f.file('cleanup.job.json')).jobEmpty, true);
        assert.equal((await cancel(f)).receipt.passed, mode === 'binding-transient', 'late cancellation must only confirm fully revalidated authority');
        assert.equal(fs.existsSync(f.file('process-authority.json')), false);
      } else if (mode === 'collector-error') {
        const result = await f.owner.done;
        assert.notEqual(result.code, 0);
        assert.match(result.stderr, /injected collector readiness failure/);
        assert.equal(read(f.file('cleanup.job.json')).jobEmpty, true);
        assert.equal((await cancel(f)).receipt.passed, true, 'late cancellation reconciles the owner exception proof');
        assert.equal(fs.existsSync(f.file('process-authority.json')), false);
      } else if (mode === 'setup-error') {
        const result = await f.owner.done;
        assert.notEqual(result.code, 0);
        assert.match(result.stderr, /injected setup failure/);
        assert.equal(fs.existsSync(f.file('launch.json')), false);
        assert.equal(fs.existsSync(f.file('cleanup.job.json')), false, 'pre-publication failure remains unconfirmed');
        assert.equal(fs.existsSync(f.file('ids.json.executed')), false);
      } else if (mode === 'launcher-exit') {
        await until(() => fs.existsSync(f.file('ids.json')), 'descendant start');
        f.owner.child.kill(); await f.owner.done;
        assert.equal(fs.existsSync(f.file('cleanup.job.json')), false, 'owner death cannot fabricate acknowledgment');
      } else {
        if (mode === 'active') await until(() => fs.existsSync(f.file('ids.json')), 'descendant start');
        if (mode === 'natural') await until(() => fs.existsSync(f.file('cleanup.job.json')), 'natural job empty');
        const result = await cancel(f);
        assert.equal(result.receipt.passed, true, JSON.stringify(result));
        assert.equal(result.receipt.jobEmpty, true);
        const ack = read(f.file('cleanup.job.json'));
        assert.equal(ack.activeProcesses, 0);
        assert.equal(ack.notStarted, mode === 'before-launch');
        if (['before-launch', 'pre-release'].includes(mode)) assert.equal(fs.existsSync(f.file('ids.json.executed')), false);
        if (mode === 'before-launch') assert.equal(fs.existsSync(f.file('launch.json')), false);
        assert.equal(fs.existsSync(f.file('process-authority.json')), false);
        const again = await cancel(f);
        assert.equal(again.receipt.passed, true);
        assert.deepEqual(read(f.file('cleanup.job.json')), ack, 'repeat request preserves immutable proof');
        assert.equal((await f.owner.done).code, 0);
      }
      await assertEnded(f);
    } finally { await finish(f); }
  });
}

test('concurrent cancellation ignores partial/stale PID ledger and preserves unrelated process', native, async () => {
  const f = await fixture('active');
  const peer = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', f.directory], { windowsHide: true, stdio: 'ignore' });
  try {
    await until(() => fs.existsSync(f.file('ids.json')), 'descendant start');
    fs.writeFileSync(f.file('process-authority.json'), JSON.stringify({ passed: false, processes: [{ pid: peer.pid, startedAt: '2000-01-01T00:00:00Z' }] }));
    const results = await Promise.all([cancel(f), cancel(f)]);
    for (const result of results) assert.equal(result.receipt.passed, true, JSON.stringify(result));
    assert.equal(peer.exitCode, null, 'same-executable unrelated generation must survive');
    assert.equal((await f.owner.done).code, 0);
    await assertEnded(f);
  } finally { peer.kill(); await finish(f); }
});

test('invalid expected binding cannot publish cancellation or stop owned workload', native, async () => {
  const f = await fixture('active');
  try {
    await until(() => fs.existsSync(f.file('ids.json')), 'descendant start');
    // Batch invalid inputs in one PowerShell process. Five cold process/module
    // startups are unrelated to cancellation semantics and can exhaust the
    // fixture's unchanged lifetime watchdog under parallel integration load.
    const checked = await powershell(String.raw`$ErrorActionPreference='Stop'; Import-Module ${quote(cleanupModule)} -Force;
$results=@(); foreach($mutate in @({$b.leaseId='other'},{$b.expectedUserSid='S-1-5-21-999'},{$b.expectedSessionId=0},{$b.expectedVmUuidBios='wrong'},{$b.PSObject.Properties.Remove('executionId')})) {
  $b=Get-Content -LiteralPath ${quote(f.file('binding.json'))} -Raw|ConvertFrom-Json; & $mutate
  $results+=Stop-OmniInteractiveOwnedProcesses -LaunchPath ${quote(f.file('launch.json'))} -ProcessAuthorityPath ${quote(f.file('process-authority.json'))} -ExpectedBinding $b -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(7))
}
ConvertTo-Json -InputObject $results -Depth 5 -Compress`).done;
    assert.equal(checked.code, 0, checked.stderr);
    const receipts = JSON.parse(checked.stdout);
    assert.equal(receipts.length, 5);
    for (const receipt of receipts) assert.equal(receipt.passed, false);
    assert.equal(fs.existsSync(f.file('cancel-request.json')), false);
    assert.equal(f.owner.child.exitCode, null);
    assert.equal((await cancel(f)).receipt.passed, true);
  } finally { await finish(f); }
});

test('missing acknowledgment remains unconfirmed within caller deadline and preserves supervisor', native, async () => {
  const f = await fixture('no-ack');
  try {
    await until(() => fs.existsSync(f.file('ids.json')), 'descendant start');
    await requestOnly(f);
    const result = await cancel(f, { milliseconds: 600 });
    assert.equal(result.receipt.passed, false);
    assert.equal(result.receipt.status, 'timeout');
    assert.ok(result.elapsedMs < 1600, JSON.stringify(result));
    assert.equal(f.owner.child.exitCode, null);
    assert.equal(fs.existsSync(f.file('cancel-request.json')), true);
    fs.writeFileSync(f.file('allow-cancel'), 'yes');
    assert.equal((await cancel(f)).receipt.passed, true);
  } finally { await finish(f); }
});

test('conflicting immutable cancellation is rejected by launch owner, never broadened', native, async () => {
  const f = await fixture('no-ack');
  try {
    await until(() => fs.existsSync(f.file('ids.json')), 'descendant start');
    await requestOnly(f);
    const request = read(f.file('cancel-request.json'));
    request.leaseId = 'not-this-lease';
    // Adversarial fixture input, not a production rewrite path.
    fs.writeFileSync(f.file('cancel-request.json'), JSON.stringify(request));
    const result = await cancel(f);
    assert.equal(result.receipt.passed, false);
    assert.equal(result.receipt.status, 'authority-invalid');
    fs.writeFileSync(f.file('allow-cancel'), 'yes');
    assert.notEqual((await f.owner.done).code, 0);
    assert.equal(read(f.file('cleanup.job.json')).jobEmpty, true, 'exception cleanup may prove its own job empty but cannot validate the conflicting request');
    assert.equal((await cancel(f)).receipt.passed, false);
  } finally { await finish(f); }
});

test('production launcher and scheduler keep job custody independent from terminal collector', () => {
  const launcher = fs.readFileSync(path.join(here, 'run-watch-mode-interactive-task.ps1'), 'utf8');
  assert.ok(launcher.indexOf('try {\n$cancellationBinding') < launcher.indexOf('$node = New-OmniInteractiveJob'));
  assert.match(launcher, /try \{ \$node.Dispose\(\) \}/);
  assert.match(launcher, /if \(\$null -ne \$launcherFailure\) \{ throw \$launcherFailure \}/);
  assert.match(launcher, /Complete-OmniInteractiveJobCleanup -Job \$node/);
  assert.match(launcher, /\$arguments = @\(\[string\]\$request.shardRunnerPath, '--execute-interactive-request', \$resolvedRequestPath\)/);
  assert.ok(launcher.indexOf('$trace = Start-Process') < launcher.indexOf('Write-OmniImmutableJson -LiteralPath ([string]$request.releasePath)'));
  assert.ok(launcher.indexOf('Write-OmniInteractiveJobAcknowledgment') < launcher.indexOf('$trace.WaitForExit'));
  const scheduler = fs.readFileSync(path.join(here, 'lib/powershell/Omni.Testing.WatchMode.InteractiveScheduler.psm1'), 'utf8');
  assert.match(scheduler, /processCleanup.passed -eq \$true\) \{/);
  assert.ok(scheduler.indexOf("throw 'interactive task cancelled before start'") < scheduler.indexOf('    Start-ScheduledTask'));
});

for (const scenario of ['verification-failure', 'ambiguous-start', 'cleanup-query-failure', 'stop-race', 'unregister-race']) {
  test('interactive scheduler no-start/cleanup proof: ' + scenario, native, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-scheduler-job-'));
    try {
      const result = await powershell(common + String.raw`
$w=${quote(directory)}; $scenario=${quote(scenario)}
$me=Identity $PID 0
$launchPath=Join-Path $w 'launch.json'
$command=[ordered]@{schemaVersion=2;artifactKind='watch-mode-interactive-task-command';mode='shard-cell';launchPath=$launchPath;executionId='fixture';planDigest=('1'*64);leaseId='lease';leaseDigest=('2'*64);cellId='c01';workerId='local';vmIdentityDigest=('3'*64);expectedUserSid=$me.ownerSid;expectedSessionId=$me.sessionId;expectedVmUuidBios=[string](Get-CimInstance Win32_ComputerSystemProduct).UUID;expectedUserId='fixture-user'}
$context=[pscustomobject]@{commandPath=(Join-Path $w 'command.json');command=$command;launcherPath='fixture.ps1';mode='shard-cell';taskPath='\Fixture\';taskName='fixture';launchPath=$launchPath;processAuthorityPath=(Join-Path $w 'process-authority.json');payload=@{timeoutMs=1000}}
Import-Module ${quote(path.join(here, 'lib/powershell/Omni.Testing.WatchMode.InteractiveScheduler.psm1'))} -Force
$module=Get-Module Omni.Testing.WatchMode.InteractiveScheduler
& $module {
  param($context,$scenario)
  $script:exists=$false; $script:gets=0; $script:starts=0; $script:stops=0; $script:unregisters=0
  $script:scenario=$scenario
  function New-ScheduledTaskAction { param($Execute,$Argument) $script:action=[pscustomobject]@{Execute=$Execute;Arguments=$Argument}; return $script:action }
  function New-ScheduledTaskPrincipal { param($UserId,$LogonType,$RunLevel) return @{} }
  function New-ScheduledTaskSettingsSet { param($ExecutionTimeLimit,[switch]$AllowStartIfOnBatteries,[switch]$DontStopIfGoingOnBatteries) return @{} }
  function Register-ScheduledTask { param($TaskPath,$TaskName,$Action,$Principal,$Settings) $script:exists=$true }
  function Get-ScheduledTask {
    param($TaskPath,$TaskName,$ErrorAction)
    $script:gets++
    if($script:gets -eq 2 -and $script:scenario -ne 'ambiguous-start'){throw 'injected verification failure'}
    if($script:gets -gt 2 -and $script:scenario -eq 'cleanup-query-failure'){throw 'injected enumeration access failure'}
    if($script:exists){return [pscustomobject]@{TaskPath='\Fixture\';TaskName='fixture';Actions=@($script:action);Principal=@{RunLevel='Limited'};State='Ready'}}
  }
  function Export-ScheduledTask {
    param($TaskPath,$TaskName)
    $escaped=[Security.SecurityElement]::Escape($script:action.Arguments)
    return '<Task><Actions><Exec><Command>powershell.exe</Command><Arguments>'+ $escaped +'</Arguments></Exec></Actions><Principals><Principal><UserId>'+ $context.command.expectedUserSid +'</UserId><LogonType>InteractiveToken</LogonType></Principal></Principals></Task>'
  }
  function Get-ScheduledTaskInfo { param($TaskPath,$TaskName) return @{LastRunTime=[DateTime]::MinValue;LastTaskResult=0} }
  function Start-ScheduledTask { param($TaskPath,$TaskName) $script:starts++; throw 'injected ambiguous start failure' }
  function Stop-ScheduledTask {
    param($TaskPath,$TaskName,$ErrorAction) $script:stops++
    if($script:scenario -eq 'stop-race'){$script:exists=$false;throw 'peer removed task during stop'}
  }
  function Unregister-ScheduledTask {
    param($TaskPath,$TaskName,$Confirm,$ErrorAction) $script:unregisters++;$script:exists=$false
    if($script:scenario -eq 'unregister-race'){throw 'peer removed task during unregister'}
  }
  if($scenario -eq 'ambiguous-start') {
    # An ambiguous start is NOT proof that no owner exists. A bounded unconfirmed
    # cleanup result must leave its scheduler supervision untouched.
    function Stop-OmniInteractiveOwnedProcesses { param($LaunchPath,$ProcessAuthorityPath,$ExpectedBinding,$DeadlineUtc) return [pscustomobject]@{passed=$false;status='timeout';processes=@()} }
  }
  $failure=$null
  try { Invoke-OmniInteractiveScheduledTask $context | Out-Null } catch { $failure=$_.Exception.Message }
  $receipt=Get-Content -LiteralPath (Join-Path (Split-Path $context.commandPath) 'cleanup.scheduler.json') -Raw|ConvertFrom-Json
  [ordered]@{failure=$failure;starts=$script:starts;stops=$script:stops;exists=$script:exists;receipt=$receipt}|ConvertTo-Json -Compress -Depth 8
} $context $scenario
`).done;
      assert.equal(result.code, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      if (scenario === 'ambiguous-start') {
        assert.equal(output.starts, 1);
        assert.equal(output.stops, 0);
        assert.equal(output.exists, true);
        assert.equal(output.receipt.passed, false);
        assert.equal(fs.existsSync(path.join(directory, 'cleanup.job.json')), false);
      } else {
        assert.equal(output.starts, 0);
        const ack = read(path.join(directory, 'cleanup.job.json'));
        assert.equal(ack.notStarted, true);
        assert.equal(output.receipt.processCleanup.passed, true);
        assert.equal(output.receipt.taskCleanupPassed, scenario !== 'cleanup-query-failure');
        assert.equal(output.receipt.passed, scenario !== 'cleanup-query-failure');
        assert.equal(output.exists, scenario === 'cleanup-query-failure');
      }
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
}

for (const scenario of ['primary-and-cleanup', 'cleanup-only', 'primary-and-dispose']) {
  test('production launcher preserves primary failure across cleanup: ' + scenario, native, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-job-primary-'));
    try {
      const runner = path.join(directory, 'never-runs.cjs');
      fs.writeFileSync(runner, 'throw new Error("suspended fixture must not run");', 'utf8');
      const launcher = fs.readFileSync(path.join(here, 'run-watch-mode-interactive-task.ps1'), 'utf8');
      const start = launcher.lastIndexOf('} catch {\n  $launcherFailure = $_');
      assert.ok(start > 0, 'use the actual production finalization/error propagation block');
      const finalize = launcher.slice(start, launcher.lastIndexOf('exit $nodeExitCode'));
      const result = await powershell(common + String.raw`
$w=${quote(directory)}; $scenario=${quote(scenario)}
$realJob=New-OmniInteractiveJob -Executable ${quote(process.execPath)} -Arguments @(${quote(runner)}) -WorkingDirectory $w -StdoutPath (Join-Path $w 'stdout.log') -StderrPath (Join-Path $w 'stderr.log')
$root=Get-Process -Id $realJob.Id; $null=$root.Handle
$node=$realJob
$jobCleanupAcknowledged=($scenario -eq 'primary-and-dispose')
$jobBinding=@{fixture=$true}; $request=@{launchPath=(Join-Path $w 'launch.json')}
$launcherFailure=$null; $jobCleanupFailure=$null
$script:disposeAttempted=$false
if($scenario -eq 'primary-and-dispose') {
  $node=[pscustomobject]@{}
  $node | Add-Member -MemberType ScriptMethod -Name Dispose -Value { $script:disposeAttempted=$true; $realJob.Dispose(); throw 'injected disposal failure' }
}
function Complete-OmniInteractiveJobCleanup {
  param($Job,$LaunchPath,$Binding,$DeadlineUtc,$ExpectedBinding)
  throw 'injected secondary cleanup failure'
}
$caught=$null
try {
  try {
    if($scenario -ne 'cleanup-only'){throw 'injected original launcher failure'}
${finalize}
} catch { $caught=$_ }
try {
  [ordered]@{message=$caught.Exception.Message;cleanupStatus=$caught.Exception.Data['interactiveJobCleanupStatus'];rootEnded=$root.WaitForExit(3000);ackExists=(Test-Path -LiteralPath (Join-Path $w 'cleanup.job.json'));disposeAttempted=$script:disposeAttempted}|ConvertTo-Json -Compress
} finally { $realJob.Dispose(); $root.Dispose() }
`).done;
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /interactive job cleanup incomplete/);
      const output = JSON.parse(result.stdout.split(/\r?\n/).at(-1));
      assert.equal(output.message, scenario === 'cleanup-only' ? 'injected secondary cleanup failure' : 'injected original launcher failure');
      assert.equal(output.cleanupStatus, scenario === 'cleanup-only' ? null : 'incomplete');
      assert.equal(output.rootEnded, true, 'finally still closes the actual retained Job');
      assert.equal(output.ackExists, false, 'failed cleanup does not invent positive custody proof');
      if (scenario === 'primary-and-dispose') assert.equal(output.disposeAttempted, true);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
}
