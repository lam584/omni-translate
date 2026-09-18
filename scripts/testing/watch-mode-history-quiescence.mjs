import path from 'node:path';
import { spawnSync } from 'node:child_process';

const MAX_PROCESSES = 50000;
const MAX_TASKS = 10000;
const MAX_ACTIONS = 50000;
const MAX_TEXT = 32768;
const MAX_OUTPUT = 8 * 1024 * 1024;
const TASK_STATES = new Set(['Disabled', 'Queued', 'Ready', 'Running']);
const PRODUCER = /watch-mode-|prepare-watch-release|distribute-watch-runtime|run-frozen-test-funnel|frozen-test-funnel-distributed|build-desktop-release/iu;
const TRANSFER = /(?:^|[\s\\/"'&|();])(?:scp|sftp|sftp-server|tar|bsdtar|robocopy|rsync)(?:\.exe)?(?=$|[\s"'&|();])/iu;
const NATIVE_PRODUCER = /^(?:omni.*|watch-worker.*|cargo|rustc|msbuild|scp|sftp|sftp-server|tar|bsdtar|robocopy|rsync)(?:\.exe)?$/iu;
// Project launchers, not arbitrary native DLL/COM execution. Native actions
// outside this set still block when their names/decoded payloads reference the
// project. Their unseen implementation is explicitly outside this IO claim.
const SCRIPT_HOST = /^(?:node|nodejs|powershell|pwsh|cmd|wscript|cscript|python(?:w|\d+)?|bash|sh|ruby|perl|mshta)(?:\.exe)?$/iu;
const RELATED_TASK = /omni|watch/iu;

// No task-name/state filtering: even disabled/stale actions can retain a cache.
// The observation helper excludes itself; the JS caller excludes only its PID.
const OBSERVE = `
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$processes=@(); $tasks=@(); $processComplete=$false; $taskComplete=$false
try {
  $processes=@(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.ProcessId -ne $PID } | Select-Object ProcessId,Name,ExecutablePath,CommandLine)
  if($processes.Count -eq 0 -or $processes.Count -gt ${MAX_PROCESSES}){throw 'process bound'}
  $processComplete=$true
} catch { $processComplete=$false }
try {
  $allTasks=@(Get-ScheduledTask -ErrorAction Stop)
  if($allTasks.Count -gt ${MAX_TASKS}){throw 'task bound'}
  $actionCount=0
  $tasks=@(foreach($task in $allTasks){
    $actions=@(foreach($action in @($task.Actions)){
      $actionCount++; if($actionCount -gt ${MAX_ACTIONS}){throw 'action bound'}
      [ordered]@{nativeName=[string]$action.CimClass.CimClassName; execute=[string]$action.Execute; arguments=[string]$action.Arguments; workingDirectory=[string]$action.WorkingDirectory; data=[string]$action.Data}
    })
    [ordered]@{taskName=$task.TaskName; taskPath=$task.TaskPath; state=[string]$task.State; enabled=$task.Settings.Enabled; actions=$actions}
  })
  $taskComplete=$true
} catch { $taskComplete=$false }
[ordered]@{schemaVersion=1; processInventoryComplete=$processComplete; taskInventoryComplete=$taskComplete; processes=@($processes); tasks=@($tasks)} | ConvertTo-Json -Depth 8 -Compress
`;

const text = (value, { empty = true, max = MAX_TEXT } = {}) => typeof value === 'string'
  && value.length <= max && !value.includes('\0') && (empty || value.trim().length > 0);
const nativeName = (value) => text(value, { empty: false })
  ? path.win32.basename(value.replace(/^"|"$/gu, '')).toLowerCase() : null;
const auditLabel = (value) => text(value, { empty: false, max: 256 }) && !/[\x00-\x1f]/u.test(value) ? value : null;
const canonicalPath = (value) => path.win32.normalize(value.replaceAll('/', '\\').replace(/^\\\\\?\\/u, '')).toLowerCase();
const inside = (root, value) => value === root || value.startsWith(root.endsWith('\\') ? root : `${root}\\`);

function referencesRoot(value, roots) {
  const lower = value.replaceAll('/', '\\').replaceAll('\\\\?\\', '').toLowerCase();
  for (const root of roots) {
    let start = -1;
    while ((start = lower.indexOf(root, start + 1)) !== -1) {
      const next = lower[start + root.length];
      if (root.endsWith('\\') || next === undefined || /[\\\s"',;)}\]]/u.test(next)) return true;
    }
  }
  // Resolve lexical .. components too; no filesystem read or executable launch.
  if (/^[a-z]:\\/u.test(lower) && roots.some((root) => inside(root, canonicalPath(lower)))) return true;
  for (const match of lower.matchAll(/"([a-z]:\\[^"]*)"|'([a-z]:\\[^']*)'/gu)) {
    if (roots.some((root) => inside(root, canonicalPath(match[1] ?? match[2])))) return true;
  }
  for (const match of lower.matchAll(/[a-z]:\\[^\s"';&|()<>]*/gu)) {
    if (roots.some((root) => inside(root, canonicalPath(match[0])))) return true;
  }
  return false;
}

function decodeCommand(value) {
  if (!value || value.length > MAX_TEXT || !/^(?:[a-z0-9+/]{4})*(?:[a-z0-9+/]{2}==|[a-z0-9+/]{3}=)?$/iu.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length % 2 || bytes.toString('base64') !== value) return null;
  try {
    const decoded = new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
    return text(decoded, { empty: false }) ? decoded : null;
  } catch { return null; }
}

function inspectCommand(value, roots, depth = 0, budget = { bytes: 0 }) {
  const reasons = new Set(); const unknown = new Set();
  if (!text(value, { empty: false }) || depth > 4 || (budget.bytes += value.length) > 128 * 1024) {
    return { reasons: [], unknown: ['command-unreadable-or-unbounded'] };
  }
  // Inspect escaped cmd/PowerShell spellings, never evaluate their content.
  const normalized = value.replace(/[\^`]/gu, '').replace(/[\u2010-\u2015]/gu, '-');
  if (referencesRoot(normalized, roots)) reasons.add('history-root-reference');
  if (PRODUCER.test(normalized)) reasons.add('watch-producer-command');
  if (TRANSFER.test(normalized)) reasons.add('transfer-command');
  if (/%[^%\r\n]+%|\$env:|\$\{env:|~\d+(?:[\\/]|$)/iu.test(normalized)) unknown.add('unresolved-path-expression');
  if (/(?:powershell|pwsh)(?:\.exe)?(?:[\s"']|$)/iu.test(normalized)) {
    for (const flag of normalized.matchAll(/(?:^|[\s"'&|();])[-/]([a-z]+)["']?(?=\s|[:=]|$)/giu)) {
      const name = flag[1].toLowerCase();
      if (name === 'ea' || name.startsWith('encodeda')) { unknown.add('encoded-arguments-unsupported'); continue; }
      if (name !== 'ec' && !'encodedcommand'.startsWith(name)) continue;
      const rest = normalized.slice(flag.index + flag[0].length);
      const operand = /^\s*(?:[:=]\s*)?(?:"([^"]*)"|'([^']*)'|([^\s"';&|()]+))/u.exec(rest);
      const decoded = decodeCommand(operand?.[1] ?? operand?.[2] ?? operand?.[3]);
      if (decoded === null) { unknown.add('encoded-command-invalid'); continue; }
      const nested = inspectCommand(decoded, roots, depth + 1, budget);
      for (const reason of nested.reasons) reasons.add(reason);
      for (const reason of nested.unknown) unknown.add(reason);
    }
  }
  return { reasons: [...reasons], unknown: [...unknown] };
}

/** Local read-only observation, NOT a lock or permission to delete stale tasks.
 * Keep producers excluded until the caller's quarantine/identity revalidation
 * finishes. A positive snapshot alone cannot close the check-to-delete race.
 * `run` is injectable for offline tests; no captured inventory is apply authority.
 */
export function probeWatchHistoryQuiescence({ roots = [], run = spawnSync, now = () => new Date() } = {}) {
  const result = { schemaVersion: 1, artifactKind: 'watch-mode-history-quiescence', observedAt: null,
    scope: 'project-history-producers', classification: 'project-name-root-and-decoded-entrypoint-signals-v1',
    passed: false, matchingProcesses: [], matchingTasks: [], unknownProcesses: [], unknownTasks: [],
    errors: [], counts: { processes: 0, tasks: 0, actions: 0, unrelatedProcesses: 0,
      unreadableUnrelatedNativeProcesses: 0, unrelatedExecActions: 0, uninspectedTaskActions: 0 },
    uninspectedTaskActionKinds: {} };
  const error = (code) => { if (!result.errors.some((entry) => entry.code === code)) result.errors.push({ code }); };
  const finish = () => {
    try { result.observedAt = now().toISOString(); } catch { error('observation-clock-unreadable'); }
    result.passed = !result.errors.length && !result.matchingProcesses.length && !result.matchingTasks.length
      && !result.unknownProcesses.length && !result.unknownTasks.length;
    return result;
  };
  if (!Array.isArray(roots) || roots.length > 16 || roots.some((root) => !text(root?.path, { empty: false })
    || !/^[a-z]:[\\/]/iu.test(root.path) || !path.win32.isAbsolute(root.path))) {
    error('invalid-history-roots'); return finish();
  }
  const canonicalRoots = roots.map((root) => canonicalPath(root.path));
  if (process.platform !== 'win32' && run === spawnSync) {
    error('windows-observation-required'); return finish();
  }
  let inventory;
  try {
    const captured = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(OBSERVE, 'utf16le').toString('base64')],
      { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: MAX_OUTPUT });
    if (captured?.error || captured?.status !== 0 || typeof captured.stdout !== 'string'
      || Buffer.byteLength(captured.stdout, 'utf8') > MAX_OUTPUT) {
      error('inventory-read-failed-or-unbounded'); return finish();
    }
    inventory = JSON.parse(captured.stdout.replace(/^\uFEFF/u, ''));
  } catch { error('inventory-unreadable'); return finish(); }
  if (!inventory || inventory.schemaVersion !== 1 || !Array.isArray(inventory.processes)
    || !Array.isArray(inventory.tasks) || !inventory.processes.length
    || inventory.processes.length > MAX_PROCESSES || inventory.tasks.length > MAX_TASKS) {
    error('inventory-shape-or-bound-invalid'); return finish();
  }
  if (inventory.processInventoryComplete !== true) error('process-inventory-incomplete');
  if (inventory.taskInventoryComplete !== true) error('task-inventory-incomplete');
  result.counts.processes = inventory.processes.length;
  result.counts.tasks = inventory.tasks.length;
  const pids = new Set();
  for (const proc of inventory.processes) {
    const pid = Number.isSafeInteger(proc?.ProcessId) && proc.ProcessId >= 0 ? proc.ProcessId : null;
    if (pid !== null && pids.has(pid)) error('duplicate-process-identity');
    pids.add(pid);
    if (pid === process.pid) continue;
    const name = nativeName(proc?.Name);
    const audit = { pid, name: name && auditLabel(name) };
    const unknown = [];
    if (pid === null || !name || !audit.name || /[\\/]/u.test(name)) unknown.push('process-identity-unreadable');
    if (proc?.ExecutablePath !== null && proc?.ExecutablePath !== undefined && !text(proc.ExecutablePath)) unknown.push('process-executable-unreadable');
    if (unknown.length) { result.unknownProcesses.push({ ...audit, reasons: unknown }); continue; }
    const potential = SCRIPT_HOST.test(name) || NATIVE_PRODUCER.test(name)
      || Boolean(proc.ExecutablePath && referencesRoot(proc.ExecutablePath, canonicalRoots));
    if (!text(proc?.CommandLine, { empty: false })) {
      // A missing service/kernel command is not evidence of a hidden script
      // host. This is scoped liveness, not a claim that unrelated native code
      // cannot perform IO. Unreadable possible producers remain blockers.
      if (potential || (proc.CommandLine != null && proc.CommandLine !== '')) {
        result.unknownProcesses.push({ ...audit, reasons: ['process-command-line-unreadable'] });
      } else { result.counts.unrelatedProcesses++; result.counts.unreadableUnrelatedNativeProcesses++; }
      continue;
    }
    const command = inspectCommand(`${name} ${proc.CommandLine}`, canonicalRoots);
    if (proc.ExecutablePath && referencesRoot(proc.ExecutablePath, canonicalRoots)) command.reasons.push('executable-in-history-root');
    if (NATIVE_PRODUCER.test(name)) command.reasons.push('producer-or-transfer-process');
    if (command.unknown.length && (potential || command.reasons.length || command.unknown.some((reason) => reason.startsWith('encoded-')))) {
      result.unknownProcesses.push({ ...audit, reasons: command.unknown });
    }
    else if (command.reasons.length) result.matchingProcesses.push({ ...audit, reasons: [...new Set(command.reasons)] });
    else result.counts.unrelatedProcesses++;
  }
  const identities = new Set();
  for (const task of inventory.tasks) {
    const audit = { taskName: auditLabel(task?.taskName), taskPath: auditLabel(task?.taskPath),
      state: TASK_STATES.has(task?.state) ? task.state : null, enabled: typeof task?.enabled === 'boolean' ? task.enabled : null };
    const identity = `${audit.taskPath}${audit.taskName}`.toLowerCase();
    const namedProducer = RELATED_TASK.test(identity);
    if (identities.has(identity)) error('duplicate-task-identity');
    identities.add(identity);
    if (!audit.taskName || !audit.taskPath || !audit.state || audit.enabled === null
      || !Array.isArray(task?.actions) || task.actions.length === 0) {
      result.unknownTasks.push({ ...audit, reasons: ['task-identity-state-or-actions-unreadable'] }); continue;
    }
    result.counts.actions += task.actions.length;
    if (result.counts.actions > MAX_ACTIONS) { error('task-action-bound-exceeded'); break; }
    for (const [actionIndex, action] of task.actions.entries()) {
      const detail = { ...audit, actionIndex, nativeName: auditLabel(action?.nativeName) };
      if (!detail.nativeName || !/^MSFT_Task[A-Za-z]+Action$/u.test(detail.nativeName)) {
        result.unknownTasks.push({ ...detail, reasons: ['task-action-class-unreadable'] }); continue;
      }
      if (action.nativeName !== 'MSFT_TaskExecAction') {
        const fields = [action.execute ?? '', action.arguments ?? '', action.workingDirectory ?? '', action.data ?? ''];
        if (fields.some((field) => !text(field))) {
          result.unknownTasks.push({ ...detail, reasons: ['task-action-data-unreadable'] }); continue;
        }
        const payload = fields.join(' ').trim();
        const evidence = payload ? inspectCommand(payload, canonicalRoots) : { reasons: [], unknown: [] };
        if (namedProducer || evidence.reasons.length || evidence.unknown.some((reason) => reason.startsWith('encoded-'))) {
          result.unknownTasks.push({ ...detail, reasons: ['project-associated-non-exec-action', ...evidence.unknown] });
        } else {
          // COM/other native actions have no Exec payload to verify. Count the
          // unassociated category instead of whitelisting Windows task names.
          result.counts.uninspectedTaskActions++;
          result.uninspectedTaskActionKinds[action.nativeName] = (result.uninspectedTaskActionKinds[action.nativeName] ?? 0) + 1;
        }
        continue;
      }
      if (!text(action.execute, { empty: false })
        || !text(action.arguments) || !text(action.workingDirectory)) {
        result.unknownTasks.push({ ...detail, reasons: ['task-action-unsupported-or-unreadable'] }); continue;
      }
      const name = nativeName(action.execute);
      if (!name) { result.unknownTasks.push({ ...detail, reasons: ['task-executable-unreadable'] }); continue; }
      const command = inspectCommand(`${action.execute} ${action.arguments}`, canonicalRoots);
      if (referencesRoot(action.workingDirectory, canonicalRoots)) command.reasons.push('working-directory-in-history-root');
      if (/%[^%]+%|\$env:|~\d+(?:[\\/]|$)/iu.test(action.workingDirectory)) command.unknown.push('unresolved-working-directory');
      if (NATIVE_PRODUCER.test(name)) command.reasons.push('producer-or-transfer-action');
      if (namedProducer) command.reasons.push('project-task-identity');
      const potential = namedProducer || SCRIPT_HOST.test(name) || NATIVE_PRODUCER.test(name) || /%|\$/u.test(name)
        || command.reasons.length || command.unknown.some((reason) => reason.startsWith('encoded-'));
      if (command.unknown.length && potential) result.unknownTasks.push({ ...detail, reasons: [...new Set(command.unknown)] });
      else if (command.reasons.length) result.matchingTasks.push({ ...detail, reasons: [...new Set(command.reasons)] });
      else {
        result.counts.unrelatedExecActions++;
        if (command.unknown.length) {
          result.counts.uninspectedTaskActions++;
          const kind = 'MSFT_TaskExecAction/unassociated-native-payload';
          result.uninspectedTaskActionKinds[kind] = (result.uninspectedTaskActionKinds[kind] ?? 0) + 1;
        }
      }
    }
  }
  // Never return raw command lines, action arguments, decoded scripts or stderr.
  return finish();
}
