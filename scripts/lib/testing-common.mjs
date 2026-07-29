import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Repository root derived from this file's location (scripts/lib/ -> repo root),
// so testing scripts no longer depend on being launched from the repo root.
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const isWindows = process.platform === 'win32';

// True when importMetaUrl belongs to the module Node was launched with (CLI mode).
export const isMain = (importMetaUrl) =>
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(importMetaUrl);

const pad = (value) => String(value).padStart(2, '0');

// Local yyyyMMdd-HHmmss, matching the historical PowerShell artifact directory naming.
export const compactTimestamp = (date = new Date()) =>
  `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
  `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;

// Local sortable timestamp (PowerShell `Get-Date -Format s`), e.g. 2026-07-27T01:30:00.
export const sortableTimestamp = (date = new Date()) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T` +
  `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;

export const ensureDir = (dirPath) => {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
};

// UTF-8 without BOM, matching the explicit UTF8Encoding(false) writers the
// PowerShell scripts used. Ensures a trailing newline for text artifacts.
export const writeText = (filePath, text) => {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
  return filePath;
};

export const writeJson = (filePath, value) => writeText(filePath, JSON.stringify(value, null, 2));

// Tolerates a UTF-8 BOM so reports written by older PowerShell tooling still parse.
export const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));

// Run one shell command line (npm/cargo/...), streaming combined output into
// logPath. Returns the exit code. stdout of the calling script stays untouched,
// so gate runners can keep their "only the summary path on stdout" contract.
export const runLoggedStep = (command, logPath, { cwd = repoRoot, env } = {}) => {
  ensureDir(path.dirname(logPath));
  const fd = fs.openSync(logPath, 'w');
  try {
    const result = spawnSync(command, { shell: true, cwd, env, stdio: ['ignore', fd, fd] });
    return result.status ?? 1;
  } finally {
    fs.closeSync(fd);
  }
};

// Run one shell command line with output streamed to the console (progress on
// the caller's own streams). Returns the exit code.
export const runCommand = (command, { cwd = repoRoot, env } = {}) => {
  const result = spawnSync(command, { shell: true, cwd, env, stdio: 'inherit' });
  return result.status ?? 1;
};

// Echo the last `lines` lines of a log file to stderr for operator progress.
export const echoLogTail = (logPath, lines = 40) => {
  if (!fs.existsSync(logPath)) {
    return;
  }
  const tail = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter((line) => line.length > 0).slice(-lines);
  for (const line of tail) {
    console.error(line);
  }
};

// Elevation probe. On Windows `net session` succeeds only from an elevated
// shell; elsewhere fall back to a root check.
export const isElevated = () => {
  if (!isWindows) {
    return typeof process.getuid === 'function' ? process.getuid() === 0 : false;
  }
  const result = spawnSync('net', ['session'], { stdio: 'ignore' });
  return result.status === 0;
};

// Minimal kebab-case CLI parser shared by the ported testing scripts.
// `booleans` lists flags that take no value; every other --flag consumes one.
// Kebab-case flags map to camelCase keys in the returned object. The accepted
// flag set is exactly `booleans` plus the keys of `defaults`: unknown flags
// fail fast instead of silently swallowing the next token.
export const parseCliArgs = (argv, { booleans = [], defaults = {} } = {}) => {
  const args = { ...defaults };
  const booleanSet = new Set(booleans);
  const toKebab = (key) => key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  const knownFlags = new Set([...booleans, ...Object.keys(defaults).map(toKebab)]);
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw.startsWith('--')) {
      throw new Error(`Unexpected argument: ${raw}`);
    }
    const flag = raw.slice(2);
    if (!knownFlags.has(flag)) {
      throw new Error(`Unknown flag --${flag}`);
    }
    const key = flag.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (booleanSet.has(flag)) {
      args[key] = true;
      continue;
    }
    const value = argv[++index];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for --${flag}`);
    }
    args[key] = value;
  }
  return args;
};

// Timestamped report writer shared by the prepare-* helper scripts: resolves
// <repoRoot>/<outputRoot>/<filePrefix>-<compactTimestamp>.<extension>, hands
// the caller the path plus the matching sortable timestamp, returns the path.
export const writeTimestampedReport = ({ outputRoot, filePrefix, extension, render }) => {
  const targetDir = ensureDir(path.resolve(repoRoot, outputRoot));
  const reportPath = path.join(targetDir, `${filePrefix}-${compactTimestamp()}.${extension}`);
  render(reportPath, sortableTimestamp());
  return reportPath;
};

// CLI seam shared by the prepare-* helper scripts: parse the flags, print the
// produced report path, or exit 1 with the bare error message.
export const runPrepareReportCli = (prepare, defaults) => {
  try {
    const args = parseCliArgs(process.argv.slice(2), { defaults });
    console.log(prepare(args));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
};

// Loose --flag [value] parser used by the watch-mode tooling: keys stay
// kebab-case, unknown flags are accepted, a flag followed by another flag
// (or by nothing) becomes boolean true, non-flag tokens are skipped.
export const parseLooseArgs = (argv) => {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    args[arg.slice(2)] = argv[index + 1]?.startsWith('--') ? true : argv[++index] ?? true;
  }
  return args;
};
