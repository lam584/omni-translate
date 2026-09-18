import { statSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';

// The caller verifies the pinned vcpkg executable before invoking this locator.
// fetch selects/version-checks existing or system tools and acquires downloads
// as needed. With --x-stderr-status, stdout is the selected path, not status.
export function requireVcpkgTool({ vcpkgExecutable, toolName, fileName, workspace, env }, spawn = spawnSync) {
  const result = spawn(vcpkgExecutable, ['fetch', toolName, '--x-stderr-status'], {
    cwd: workspace, env, encoding: 'utf8',
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const fail = (reason, cause = result.error) => {
    throw new Error(
      `vcpkg fetch ${toolName} failed: ${reason}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      { cause },
    );
  };
  if (result.error || result.status !== 0) {
    fail(`exit status=${result.status} signal=${result.signal ?? 'none'}`);
  }
  const executable = stdout.trim();
  // Do not fall back to scanning downloads: bundled Perl tools and stale
  // versions are not necessarily the executable selected by pinned vcpkg.
  if (!isAbsolute(executable) || /[\r\n]/u.test(executable)
      || basename(executable).toLowerCase() !== fileName.toLowerCase()) {
    fail('expected one absolute ' + fileName + ' path');
  }
  let stats;
  try {
    stats = statSync(executable);
  } catch (error) {
    fail('selected tool is inaccessible: ' + executable, error);
  }
  if (!stats.isFile()) fail('selected tool is not a regular file: ' + executable);
  return executable;
}
