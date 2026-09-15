import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { requireVcpkgTool } from './run-aec3-msvc-gate-tool-locator.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'aec3-tool-locator-'));
  t.diagnostic('fixture retained: ' + root);
  const options = {
    vcpkgExecutable: join(root, 'pinned-vcpkg.exe'),
    toolName: 'cmake', fileName: 'cmake.exe', workspace: root,
    env: { VCPKG_DOWNLOADS: join(root, 'downloads'), TEMP: join(root, 'temp') },
  };
  const file = (relative) => {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'fixture, not executed');
    return path;
  };
  return { root, options, file };
}

for (const location of ['existing', 'system', 'downloaded']) {
  test('uses vcpkg selected ' + location + ' tool, not a directory guess', (t) => {
    const { root, options, file } = fixture(t);
    const selectedRelative = location === 'system'
      ? 'Program Files/CMake/bin/cmake.exe' : 'downloads/tools/cmake-current/bin/cmake.exe';
    // Neither an old owned copy nor a bundled Perl copy may override fetch.
    file('downloads/tools/cmake-obsolete/bin/cmake.exe');
    file('downloads/tools/perl/bin/cmake.exe');
    let selected = join(root, selectedRelative);
    if (location !== 'downloaded') selected = file(selectedRelative);
    let calls = 0;
    const spawn = (command, args, spawnOptions) => {
      calls++;
      assert.equal(command, options.vcpkgExecutable);
      assert.deepEqual(args, ['fetch', 'cmake', '--x-stderr-status']);
      assert.equal(spawnOptions.cwd, options.workspace);
      assert.equal(spawnOptions.env, options.env);
      assert.equal(spawnOptions.encoding, 'utf8');
      if (location === 'downloaded') file(selectedRelative);
      return { status: 0, stdout: selected + '\r\n', stderr: 'tool selection status\n' };
    };
    assert.equal(requireVcpkgTool(options, spawn), selected);
    assert.equal(calls, 1);
  });
}

test('supports the same fetch protocol for Ninja', (t) => {
  const { options, file } = fixture(t);
  const selected = file('system/ninja.exe');
  assert.equal(requireVcpkgTool({ ...options, toolName: 'ninja', fileName: 'ninja.exe' },
    (_command, args) => {
      assert.deepEqual(args, ['fetch', 'ninja', '--x-stderr-status']);
      return { status: 0, stdout: selected + '\n', stderr: '' };
    }), selected);
});

test('fetch failure preserves exit status and both output streams; no cached fallback', (t) => {
  const { options, file } = fixture(t);
  const cached = file('downloads/tools/cmake-old/bin/cmake.exe');
  assert.throws(() => requireVcpkgTool(options, () => ({
    status: 7, stdout: cached + '\n', stderr: 'download hash rejected',
  })), (error) => {
    assert.match(error.message, /7/);
    assert.ok(error.message.includes(cached));
    assert.match(error.message, /download hash rejected/);
    return true;
  });
});

test('spawn failure preserves its cause and diagnostics', (t) => {
  const { options } = fixture(t);
  const cause = new Error('spawn ENOENT');
  assert.throws(() => requireVcpkgTool(options, () => ({
    status: null, error: cause, stdout: 'partial output', stderr: 'spawn diagnostic',
  })), (error) => {
    assert.equal(error.cause, cause);
    assert.match(error.message, /partial output/);
    assert.match(error.message, /spawn diagnostic/);
    return true;
  });
});

for (const invalid of ['empty', 'relative', 'missing', 'directory', 'multiple', 'wrong-name']) {
  test('rejects ' + invalid + ' fetch output without directory fallback', (t) => {
    const { root, options, file } = fixture(t);
    const cached = file('downloads/tools/cmake-old/bin/cmake.exe');
    const directory = join(root, 'directory/cmake.exe');
    mkdirSync(directory, { recursive: true });
    const outputs = {
      empty: '', relative: 'cmake.exe', missing: join(root, 'missing/cmake.exe'),
      directory, multiple: cached + '\n' + cached,
      'wrong-name': file('system/not-cmake.exe'),
    };
    assert.throws(() => requireVcpkgTool(options, () => ({
      status: 0, stdout: outputs[invalid], stderr: 'retained diagnostic',
    })), /retained diagnostic/);
  });
}
