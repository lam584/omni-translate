import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

import {
  assertPinnedVcpkgWebRtcPort,
  collectAec3SourceProvenanceViolations,
  OFFICIAL_AEC3_PROVENANCE,
} from './verify-aec3-official-source-provenance.mjs';

function hash(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

test('autocrlf checkout preserves every official source raw blob hash', (t) => {
  const workspace = resolve(import.meta.dirname, '..', '..');
  const root = mkdtempSync(join(tmpdir(), 'omni-aec3-provenance-checkout-'));
  // Isolate user/system attributes and inherited Git repository/index overrides.
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = join(root, 'absent-global-config');
  const git = (cwd, args, input) => execFileSync('git', [
    '-c', 'core.attributesFile=', ...args,
  ], { cwd, env, input, stdio: ['pipe', 'pipe', 'pipe'] });
  t.diagnostic(`checkout evidence retained at ${root}`);
  git(root, ['init', '--quiet']);
  git(root, ['config', 'core.autocrlf', 'true']);
  git(root, ['config', 'core.eol', 'crlf']);
  const stageRaw = (path, bytes) => {
    // Bypass clean filters: the index must contain the actual HEAD blob bytes.
    const oid = git(root, ['hash-object', '-w', '--stdin'], bytes).toString().trim();
    git(root, ['update-index', '--add', '--cacheinfo', '100644', oid, path]);
  };
  const attributes = readFileSync(join(workspace, '.gitattributes'));
  writeFileSync(join(root, '.gitattributes'), attributes);
  stageRaw('.gitattributes', attributes);
  stageRaw('autocrlf-control.txt', Buffer.from('control\n'));
  const sources = OFFICIAL_AEC3_PROVENANCE.sources.map((source) => {
    const path = `crates/omni-webrtc-aec3/ffi/${source.vendoredPath}`;
    const blob = git(workspace, ['cat-file', 'blob', `HEAD:${path}`]);
    assert.equal(hash(blob), source.sha256, `HEAD raw blob: ${path}`);
    stageRaw(path, blob);
    return { ...source, path, blob };
  });
  // Exercise Git's checkout conversion, not a simulated LF/CRLF replacement.
  git(root, ['checkout-index', '--all', '--force']);
  assert.equal(readFileSync(join(root, 'autocrlf-control.txt'), 'utf8'), 'control\r\n');
  const mismatches = [];
  for (const { path, blob, sha256 } of sources) {
    const checkedOut = readFileSync(join(root, path));
    const actual = hash(checkedOut);
    t.diagnostic(`${path} expected=${sha256} actual=${actual}`);
    if (!checkedOut.equals(blob) || actual !== sha256) {
      mismatches.push(`${path} expected=${sha256} actual=${actual}`);
    }
  }
  assert.deepEqual(mismatches, [], 'checkout must preserve all official raw bytes');
});

function write(root, relativePath, contents) {
  const path = join(root, ...relativePath.split('/'));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'omni-aec3-provenance-'));
  const creator = 'scoped_refptr<EchoDetector> CreateEchoDetector() { return official(); }\n';
  const residual = 'float ResidualEchoDetector::GetMetrics() { return 0; }\n';
  const helper = 'void official_helper() {}\n';
  const sources = [
    ['api/audio/echo_detector_creator.cc', creator],
    ['modules/audio_processing/residual_echo_detector.cc', residual],
    ['modules/audio_processing/echo_detector/circular_buffer.cc', helper],
  ].map(([upstreamPath, contents]) => ({
    upstreamPath,
    vendoredPath: `upstream/webrtc/${upstreamPath}`,
    sha256: hash(contents),
    contents,
  }));
  const provenance = {
    repository: 'https://official.invalid/webrtc',
    commit: '1111111111111111111111111111111111111111',
    vcpkgBaseline: '2222222222222222222222222222222222222222',
    vcpkgPortTree: '3333333333333333333333333333333333333333',
    sources,
  };
  write(root, 'crates/omni-webrtc-aec3/vcpkg.json', JSON.stringify({
    'builtin-baseline': provenance.vcpkgBaseline,
  }));
  write(root, 'crates/omni-webrtc-aec3/ffi/CMakeLists.txt', `
    add_library(omni_webrtc_aec3_ffi STATIC
      omni_webrtc_aec3.cc
      ${sources.map(({ vendoredPath }) => vendoredPath).join('\n      ')}
    )
  `);
  write(root, 'crates/omni-webrtc-aec3/ffi/omni_webrtc_aec3.cc', 'void wrapper() {}\n');
  for (const source of sources) {
    write(root, `crates/omni-webrtc-aec3/ffi/${source.vendoredPath}`, source.contents);
  }
  write(
    root,
    'crates/omni-webrtc-aec3/build.rs',
    'fn main() { println!("cargo:rerun-if-changed=ffi/upstream/webrtc"); }\n',
  );
  write(root, 'crates/omni-webrtc-aec3/ffi/omni_webrtc_aec3_fixture.cc', `
    constexpr std::size_t kTotalFrames = 600;
    std::isfinite(stats.residual_echo_likelihood);
    stats.residual_echo_likelihood < 0.0;
    stats.residual_echo_likelihood > 1.0;
    omni_webrtc_aec3_reset(aec);
    if (after_reset.reset_count != 1) return 1;
  `);
  return { root, provenance };
}

function withFixture(callback) {
  const fixture = createFixture();
  try {
    callback(fixture);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

test('accepts only exact hash-pinned official sources in the production library', () => {
  withFixture(({ root, provenance }) => {
    assert.deepEqual(collectAec3SourceProvenanceViolations(root, provenance), []);
  });
});

test('rejects a local compatibility factory even when it claims to copy WebRTC', () => {
  withFixture(({ root, provenance }) => {
    const cmakePath = 'crates/omni-webrtc-aec3/ffi/CMakeLists.txt';
    write(root, cmakePath, `
      add_library(omni_webrtc_aec3_ffi STATIC
        omni_webrtc_aec3.cc
        ${provenance.sources.map(({ vendoredPath }) => vendoredPath).join('\n        ')}
        webrtc_echo_detector_compat.cc
      )
    `);
    write(root, 'crates/omni-webrtc-aec3/ffi/webrtc_echo_detector_compat.cc', `
      // Copied from official WebRTC.
      class ResidualEchoDetectorCompat {};
      scoped_refptr<EchoDetector> CreateEchoDetector() { return local_rewrite(); }
    `);
    const violations = collectAec3SourceProvenanceViolations(root, provenance);
    assert.ok(violations.some((message) => message.includes('unapproved source')));
    assert.ok(violations.some((message) => message.includes('local CreateEchoDetector factory')));
    assert.ok(violations.some((message) => message.includes('local ResidualEchoDetector rewrite')));
  });
});

test('rejects tampering with a vendored official compilation unit', () => {
  withFixture(({ root, provenance }) => {
    write(
      root,
      `crates/omni-webrtc-aec3/ffi/${provenance.sources[1].vendoredPath}`,
      `${provenance.sources[1].contents}// local algorithm change\n`,
    );
    const violations = collectAec3SourceProvenanceViolations(root, provenance);
    assert.ok(violations.some((message) => message.includes('official source hash mismatch')));
  });
});

test('binds the installed vcpkg port tree to the same official commit', () => {
  const provenance = {
    commit: '1111111111111111111111111111111111111111',
    vcpkgBaseline: '2222222222222222222222222222222222222222',
    vcpkgPortTree: '3333333333333333333333333333333333333333',
  };
  assert.doesNotThrow(() => assertPinnedVcpkgWebRtcPort({
    baseline: provenance.vcpkgBaseline,
    portTree: provenance.vcpkgPortTree,
    portfile: `set(WEBRTC_SOURCE_REF "${provenance.commit}")`,
  }, provenance));
  assert.throws(() => assertPinnedVcpkgWebRtcPort({
    baseline: provenance.vcpkgBaseline,
    portTree: 'locally-modified-port-tree',
    portfile: `set(WEBRTC_SOURCE_REF "${provenance.commit}")`,
  }, provenance), /port tree mismatch/u);
});
