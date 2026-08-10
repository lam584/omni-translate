import { execFileSync } from 'node:child_process';

export const GIT_PROVENANCE_SCHEMA_VERSION = 1;

const runGit = (args, cwd) => execFileSync('git', args, {
  cwd,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
}).trim();

/**
 * Captures the exact source state used by a generated test artifact without
 * embedding machine-specific paths or the names of dirty files.
 */
export function currentGitProvenance({ cwd = process.cwd() } = {}) {
  try {
    const headCommit = runGit(['rev-parse', '--verify', 'HEAD'], cwd) || null;
    const status = runGit([
      'status',
      '--porcelain=v1',
      '--untracked-files=all',
      '--ignore-submodules=none',
    ], cwd);
    const dirtyEntryCount = status
      ? status.split(/\r?\n/).filter((line) => line.length > 0).length
      : 0;
    return {
      schemaVersion: GIT_PROVENANCE_SCHEMA_VERSION,
      source: 'git',
      captureStatus: 'captured',
      headCommit,
      worktreeClean: dirtyEntryCount === 0,
      dirtyEntryCount,
    };
  } catch {
    return {
      schemaVersion: GIT_PROVENANCE_SCHEMA_VERSION,
      source: 'git',
      captureStatus: 'unavailable',
      headCommit: null,
      worktreeClean: false,
      dirtyEntryCount: null,
    };
  }
}

export function gitProvenanceShapeFailure(provenance, subject = 'source provenance') {
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) {
    return `${subject} is missing`;
  }
  if (provenance.schemaVersion !== GIT_PROVENANCE_SCHEMA_VERSION) {
    return `${subject}.schemaVersion must be ${GIT_PROVENANCE_SCHEMA_VERSION}`;
  }
  if (provenance.source !== 'git' || provenance.captureStatus !== 'captured') {
    return `${subject} was not captured from git`;
  }
  if (typeof provenance.headCommit !== 'string' || !provenance.headCommit.trim()) {
    return `${subject}.headCommit is missing`;
  }
  if (provenance.worktreeClean !== true) {
    return `${subject} records a dirty worktree or untracked source state`;
  }
  if (provenance.dirtyEntryCount !== 0) {
    return `${subject}.dirtyEntryCount must be 0 for clean strict evidence`;
  }
  return null;
}

/**
 * Strict evidence is valid only for the exact clean checkout being verified.
 * An ancestor is intentionally insufficient because it does not exercise the
 * source changes between that ancestor and the current HEAD.
 */
export function exactGitProvenanceFailure(
  recorded,
  current,
  { recordedSubject = 'recorded provenance', currentSubject = 'current checkout' } = {},
) {
  const recordedFailure = gitProvenanceShapeFailure(recorded, recordedSubject);
  if (recordedFailure) return recordedFailure;
  const currentFailure = gitProvenanceShapeFailure(current, currentSubject);
  if (currentFailure) return currentFailure;
  if (recorded.headCommit.trim() !== current.headCommit.trim()) {
    return `${recordedSubject}.headCommit ${recorded.headCommit.trim()} does not exactly match current HEAD ${current.headCommit.trim()}; ancestor commits are not accepted`;
  }
  return null;
}
