import assert from 'node:assert/strict';
import test from 'node:test';
import { probeWatchHistoryQuiescence } from './watch-mode-history-quiescence.mjs';

const roots = [{ path: 'E:\\omni-shards-run3' }];
const at = '2026-09-12T07:00:00.000Z';
const ordinary = { ProcessId: 101, Name: 'explorer.exe', ExecutablePath: 'C:\\Windows\\explorer.exe', CommandLine: 'C:\\Windows\\explorer.exe' };
const ps = (command) => ({ ProcessId: 102, Name: 'powershell.exe', ExecutablePath: 'C:\\Windows\\powershell.exe', CommandLine: command });
const encoded = (body, flag = '-EncodedCommand') => `powershell.exe ${flag} ${Buffer.from(body, 'utf16le').toString('base64')}`;
const action = (execute = 'C:\\Windows\\notepad.exe', args = '') => ({ nativeName: 'MSFT_TaskExecAction', execute, arguments: args, workingDirectory: '' });
const task = (actions = [action()], extra = {}) => ({ taskName: 'fixture-task', taskPath: '\\Review\\', state: 'Ready', enabled: true, actions, ...extra });
const snapshot = (extra = {}) => ({ schemaVersion: 1, processInventoryComplete: true, taskInventoryComplete: true, processes: [ordinary], tasks: [], ...extra });
const probe = (value = snapshot(), extra = {}) => probeWatchHistoryQuiescence({ roots, now: () => new Date(at), run: () => ({ status: 0, stdout: JSON.stringify(value) }), ...extra });

test('complete process AND task observations are required; the result is compatible and read-only', () => {
  let calls = 0;
  const receipt = probe(snapshot({ tasks: [task()] }), { run: (exe, args, options) => {
    calls += 1;
    assert.equal(exe, 'powershell.exe');
    assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    const script = Buffer.from(args[3], 'base64').toString('utf16le');
    assert.match(script, /Get-CimInstance Win32_Process/u);
    assert.match(script, /Get-ScheduledTask -ErrorAction Stop/u);
    assert.match(script, /\.Actions/u);
    assert.match(script, /\.State/u);
    assert.match(script, /\.Settings\.Enabled/u);
    assert.doesNotMatch(script, /(?:Remove|Disable|Unregister|Set|Start)-ScheduledTask|Remove-Item|Invoke-Command|CimSession/u);
    assert.equal(options.windowsHide, true);
    assert.ok(options.timeout > 0 && options.timeout <= 20000);
    assert.ok(options.maxBuffer > 0 && options.maxBuffer <= 8 * 1024 * 1024);
    return { status: 0, stdout: '\uFEFF' + JSON.stringify(snapshot({ tasks: [task()] })) };
  } });
  assert.equal(calls, 1);
  assert.equal(receipt.passed, true);
  assert.equal(receipt.observedAt, at);
  assert.deepEqual(receipt.matchingProcesses, []);
  assert.deepEqual(receipt.matchingTasks, []);
});

test('exclude only the caller PID, not a concurrent history maintainer', () => {
  assert.equal(probe(snapshot({ processes: [{ ProcessId: process.pid, Name: null, CommandLine: null }] })).passed, true);
  assert.equal(probe(snapshot({ processes: [ps('node watch-mode-typed-history.mjs --apply')] })).matchingProcesses.length, 1);
});

for (const command of [
  encoded("Get-Item 'E:\\omni-shards-run3\\local-isolation-old\\target\\x'"),
  encoded('& node.exe C:\\tools\\watch-mode-local-isolation.mjs'),
  'cmd.exe /s /c "' + encoded('& node.exe C:\\tools\\prepare-watch-release.mjs', '-enc') + '"',
  'cmd.exe /c powershell.exe -File "E:\\omni-shards-run3\\opaque-script.ps1"',
  'powershell.exe -File E:/OMNI-SHARDS-RUN3/job.ps1',
  'powershell.exe -File "\\\\?\\E:\\omni-shards-run3\\job.ps1"',
  'powershell.exe -File "E:\\scratch\\..\\omni-shards-run3\\job.ps1"',
]) test('decoded/nested root or producer is not quiescent: ' + command.slice(0, 48), () => {
  const result = probe(snapshot({ processes: [ps(command)] }));
  assert.equal(result.passed, false);
  assert.equal(result.matchingProcesses.length, 1);
});

test('differential regression: the former name-only probe misses encoded producers', () => {
  const command = encoded("& node.exe 'E:\\omni-shards-run3\\opaque.mjs'");
  const legacy = /watch-mode-(?!typed-history|disk-lifecycle)|prepare-watch-release|distribute-watch-runtime|run-frozen-test-funnel|build-desktop-release/iu;
  assert.equal(legacy.test(command), false);
  assert.equal(probe(snapshot({ processes: [ps(command)] })).passed, false);
});

for (const name of ['scp.exe', 'sftp.exe', 'sftp-server.exe', 'tar.exe', 'bsdtar.exe']) {
  test(`${name} transfers block even without a visible watch process`, () => {
    const result = probe(snapshot({ processes: [{ ProcessId: 103, Name: name, ExecutablePath: `C:\\tools\\${name}`, CommandLine: `${name} -t E:/omni-shards-run3/x` }] }));
    assert.equal(result.passed, false);
    assert.equal(result.matchingProcesses.length, 1);
    assert.equal(probe(snapshot({ tasks: [task([action('cmd.exe', `/c ${name} x`)])] })).passed, false);
  });
}

test('a root name substring is not a reference to its sibling directory', () => {
  assert.equal(probe(snapshot({ processes: [ps('powershell.exe -File E:\\omni-shards-run3-old\\unrelated.ps1')] })).passed, true);
});

for (const args of ['-EncodedCommand', '-enc !!!!', '-e YQ==', '-ec AAA=', '-EncodedCommand "unterminated', '-EncodedArguments AAAA']) {
  test(`invalid encoded PowerShell is unknown for processes and native task actions: ${args}`, () => {
    const processes = probe(snapshot({ processes: [ps(`powershell.exe ${args}`)] }));
    assert.equal(processes.passed, false);
    assert.equal(processes.unknownProcesses.length, 1);
    const tasks = probe(snapshot({ tasks: [task([action('powershell.exe', args)])] }));
    assert.equal(tasks.passed, false);
    assert.equal(tasks.unknownTasks.length, 1);
  });
}

test('nested encoded commands are bounded, never silently truncated', () => {
  let command = 'Get-Date';
  for (let i = 0; i < 7; i += 1) command = encoded(command);
  const result = probe(snapshot({ processes: [ps(command)] }));
  assert.equal(result.passed, false);
  assert.equal(result.unknownProcesses.length, 1);
});

for (const state of ['Ready', 'Running', 'Queued', 'Disabled']) {
  test(`related ${state} scheduled task blocks; disabled/stale is not deletion permission`, () => {
    const result = probe(snapshot({ tasks: [task([action('node.exe', 'C:\\tools\\run-watch-mode-live-production-coordinator.mjs')], { state, enabled: state !== 'Disabled' })] }));
    assert.equal(result.passed, false);
    assert.equal(result.matchingProcesses.length, 0);
    assert.equal(result.matchingTasks.length, 1);
    assert.equal(result.matchingTasks[0].state, state);
    assert.equal(result.matchingTasks[0].enabled, state !== 'Disabled');
  });
}

test('all task actions, working directories, and encoded actions are inspected', () => {
  const result = probe(snapshot({ tasks: [
    task([action(), action('powershell.exe', encoded('C:\\tools\\watch-mode-local-isolation.mjs').replace('powershell.exe ', ''))]),
    task([{ ...action(), workingDirectory: 'E:\\omni-shards-run3\\pending' }], { taskName: 'other-task' }),
  ] }));
  assert.equal(result.passed, false);
  assert.equal(result.matchingTasks.length, 2);
  assert.equal(result.matchingTasks[0].actionIndex, 1);
});

test('79 stale related tasks remain 79 blockers without mutation or a process requirement', () => {
  const tasks = Array.from({ length: 79 }, (_, i) => task([action('node.exe', 'E:\\omni-shards-run3\\worker.mjs')], { taskName: `stale-${i}`, enabled: false, state: 'Disabled' }));
  const result = probe(snapshot({ tasks }));
  assert.equal(result.passed, false);
  assert.equal(result.matchingTasks.length, 79);
});

for (const actions of [[], [{ ...action(), nativeName: null }], [{ ...action(), nativeName: '__proto__' }], [{ ...action(), execute: '' }]]) {
  test('unsupported or opaque task action stays unknown: ' + JSON.stringify(actions), () => {
    const result = probe(snapshot({ tasks: [task(actions)] }));
    assert.equal(result.passed, false);
    assert.ok(result.unknownTasks.length > 0);
  });
}

for (const extra of [{ state: 'Unknown' }, { enabled: null }, { actions: null }]) {
  test('incomplete task state/actions cannot pass: ' + JSON.stringify(extra), () => {
    const result = probe(snapshot({ tasks: [task([action()], extra)] }));
    assert.equal(result.passed, false);
    assert.ok(result.unknownTasks.length > 0);
  });
}

test('hidden process commands, environment paths and missing identities are unknown', () => {
  for (const proc of [{ ...ps(''), CommandLine: null }, { ...ps(''), Name: null }, ps('powershell.exe -File %HISTORY_ROOT%\\job.ps1')]) {
    const result = probe(snapshot({ processes: [proc] }));
    assert.equal(result.passed, false);
    assert.equal(result.unknownProcesses.length, 1);
  }
});

for (const extra of [{ processInventoryComplete: false }, { taskInventoryComplete: false }, { tasks: undefined }, { processes: [] }, { tasks: Array(10001).fill(task()) }]) {
  test('incomplete/empty/oversize inventories do not claim quiescence', () => {
    const result = probe(snapshot(extra));
    assert.equal(result.passed, false);
    assert.ok(result.errors.length > 0);
  });
}

test('duplicate process or task identities invalidate the inventory', () => {
  assert.equal(probe(snapshot({ processes: [ordinary, ordinary] })).passed, false);
  assert.equal(probe(snapshot({ tasks: [task(), task()] })).passed, false);
});

test('failures and invalid JSON are unknown, without command tokens, decoded content or stderr', () => {
  const secret = 'SECRET_TOKEN_NEVER_EMIT';
  for (const run of [
    () => ({ status: 1, stderr: secret }),
    () => ({ status: 0, stdout: '{not-json', stderr: secret }),
    () => ({ status: 0, stdout: JSON.stringify(snapshot()), error: new Error(secret) }),
    () => { throw new Error(secret); },
  ]) {
    const result = probe(snapshot(), { run });
    assert.equal(result.passed, false);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret, 'u'));
  }
  const result = probe(snapshot({ processes: [ps(encoded(`node C:\\tools\\prepare-watch-release.mjs --token ${secret}`))], tasks: [task([action('powershell.exe', `-enc ${secret}`)])] }));
  assert.equal(result.passed, false);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret, 'u'));
  assert.equal('CommandLine' in result.matchingProcesses[0], false);
});

test('non-absolute roots and unbounded command text fail closed', () => {
  assert.equal(probe(snapshot(), { roots: [{ path: 'relative' }] }).passed, false);
  assert.equal(probe(snapshot({ processes: [ps('x'.repeat(32769))] })).passed, false);
});

test('native process identity still recognizes encoded switches if argv omits the executable', () => {
  const result = probe(snapshot({ processes: [ps('-enc !!!!')] }));
  assert.equal(result.passed, false);
  assert.equal(result.unknownProcesses.length, 1);
});

test('EncodedArguments abbreviation cannot be mistaken for cleartext', () => {
  assert.equal(probe(snapshot({ tasks: [task([action('powershell.exe', '-EncodedA AAAA')])] })).unknownTasks.length, 1);
});

test('quoted dot-segment paths with spaces still refer to the protected root', () => {
  const result = probe(snapshot({ processes: [ps('powershell.exe -File "E:\\scratch\\..\\history with space\\job.ps1"')] }), { roots: [{ path: 'E:\\history with space' }] });
  assert.equal(result.matchingProcesses.length, 1);
});

test('unrelated native services and unassociated COM tasks are counted, not global IO blockers', () => {
  const tasks = Array.from({ length: 112 }, (_, i) => task([{ nativeName: 'MSFT_TaskComHandlerAction' }], { taskName: 'OS-task-' + i, taskPath: '\\Microsoft\\Windows\\' }));
  tasks.push(task([action('%windir%\\System32\\sc.exe', 'query')], { taskName: 'native-system-task' }));
  const result = probe(snapshot({ processes: [{ ProcessId: 104, Name: 'svchost.exe', ExecutablePath: null, CommandLine: null }, { ProcessId: 0, Name: 'System Idle Process', ExecutablePath: null, CommandLine: null }], tasks }));
  assert.equal(result.passed, true);
  assert.equal(result.scope, 'project-history-producers');
  assert.equal(result.counts.unreadableUnrelatedNativeProcesses, 2);
  assert.equal(result.counts.unrelatedExecActions, 1);
  assert.equal(result.uninspectedTaskActionKinds.MSFT_TaskComHandlerAction, 112);
});

test('COM/unsupported actions associated by project name or root data remain unknown', () => {
  for (const entry of [
    task([{ nativeName: 'MSFT_TaskComHandlerAction' }], { taskName: 'OmniPaid-stale' }),
    task([{ nativeName: 'MSFT_TaskComHandlerAction' }], { taskPath: '\\WatchTasks\\' }),
    task([{ nativeName: 'MSFT_TaskComHandlerAction', data: 'E:\\omni-shards-run3\\job' }]),
    task([{ nativeName: 'MSFT_TaskComHandlerAction', data: encoded('C:\\tools\\watch-mode-local-isolation.mjs') }]),
    task([{ nativeName: 'MSFT_TaskComHandlerAction', data: 'powershell.exe -enc !!!!' }]),
  ]) {
    const result = probe(snapshot({ tasks: [entry] }));
    assert.equal(result.passed, false);
    assert.equal(result.unknownTasks.length, 1);
  }
});

test('native exe with unknown command cannot be ignored if its executable lives in history', () => {
  const result = probe(snapshot({ processes: [{ ProcessId: 104, Name: 'custom.exe', ExecutablePath: 'E:\\omni-shards-run3\\custom.exe', CommandLine: null }] }));
  assert.equal(result.passed, false);
  assert.equal(result.unknownProcesses.length, 1);
});

test('hidden script hosts are still unknown regardless of unrelated service and COM counts', () => {
  for (const name of ['node.exe', 'pwsh.exe', 'cmd.exe', 'wscript.exe', 'python.exe']) {
    const result = probe(snapshot({ processes: [{ ProcessId: 104, Name: name, ExecutablePath: null, CommandLine: null }], tasks: [task([{ nativeName: 'MSFT_TaskComHandlerAction' }])] }));
    assert.equal(result.passed, false);
    assert.equal(result.unknownProcesses.length, 1);
    assert.equal(result.counts.uninspectedTaskActions, 1);
  }
});

test('a task with unresolved executable identity stays a potential worker', () => {
  const result = probe(snapshot({ tasks: [task([action('%WORKER_EXECUTABLE%', '')])] }));
  assert.equal(result.passed, false);
  assert.equal(result.unknownTasks.length, 1);
});

test('unassociated native DLL actions are scoped out by role, not by an OS task/directory whitelist', () => {
  const native = action('%windir%\\System32\\rundll32.exe', '%windir%\\System32\\example.dll,Entry');
  const result = probe(snapshot({ tasks: [task([native])] }));
  assert.equal(result.passed, true);
  assert.equal(result.uninspectedTaskActionKinds['MSFT_TaskExecAction/unassociated-native-payload'], 1);
  const named = probe(snapshot({ tasks: [task([native], { taskName: 'Omni-native-task' })] }));
  assert.equal(named.passed, false);
  assert.equal(named.unknownTasks.length, 1);
  const referenced = probe(snapshot({ tasks: [task([action('rundll32.exe', 'E:\\omni-shards-run3\\plugin.dll,Entry')])] }));
  assert.equal(referenced.passed, false);
  assert.equal(referenced.matchingTasks.length, 1);
});
