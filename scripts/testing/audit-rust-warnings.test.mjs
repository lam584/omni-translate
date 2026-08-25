import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectWorkspaceWarnings,
  parseCompilerWarnings,
  parseProcMacroDiagnostics,
} from './audit-rust-warnings.mjs';

function compilerMessage({ packageId = 'path+file:///repo#omni-desktop-shell@0.1.0', line = 8 } = {}) {
  return JSON.stringify({
    reason: 'compiler-message',
    package_id: packageId,
    message: {
      level: 'warning',
      message: 'item cannot be reached from outside the crate',
      code: { code: 'unreachable_pub' },
      spans: [{ file_name: 'apps/desktop/src-tauri/src/audio/mod.rs', line_start: line, column_start: 1, is_primary: true }],
    },
  });
}

test('deduplicates compiler warnings by package, lint, primary span, and message', () => {
  const warning = compilerMessage();
  const changedLocation = compilerMessage({ line: 9 });
  assert.equal(parseCompilerWarnings(`${warning}\n${warning}\n${changedLocation}\n`).length, 2);
});

test('ignores dependency warnings while retaining first-party packages', () => {
  const dependency = compilerMessage({ packageId: 'registry+https://github.com/rust-lang/crates.io-index#dependency@1.0.0' });
  assert.deepEqual(parseCompilerWarnings(dependency), []);
});

test('deduplicates ts-rs stderr diagnostics by serde attribute', () => {
  const diagnostic = 'warning: failed to parse serde attribute\n  |\n  | #[serde(skip_serializing_if = "Vec::is_empty")]\n  |\n  = note: ts-rs failed to parse this attribute. It will be ignored.\n';
  assert.deepEqual(parseProcMacroDiagnostics(diagnostic + diagnostic), [
    'ts-rs: #[serde(skip_serializing_if = "Vec::is_empty")]',
  ]);
});

test('always invokes a workspace all-target check in an isolated target directory', () => {
  let invocation;
  const result = collectWorkspaceWarnings({
    environment: {},
    runner(command, args, options) {
      invocation = { command, args, options };
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(invocation.command, 'cargo');
  assert.deepEqual(invocation.args, ['check', '--workspace', '--all-targets', '--message-format=json']);
  assert.equal(invocation.options.env.CARGO_BUILD_JOBS, '1');
  assert.match(invocation.options.env.CARGO_TARGET_DIR, /omni-rust-warning-audit-/u);
  assert.deepEqual(result.summary, {
    packages: {},
    lints: {},
    procMacroDiagnostics: 0,
  });
});

test('preserves an explicit cargo build job limit', () => {
  let invocation;
  collectWorkspaceWarnings({
    environment: { CARGO_BUILD_JOBS: '3' },
    runner(command, args, options) {
      invocation = { command, args, options };
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(invocation.options.env.CARGO_BUILD_JOBS, '3');
});
