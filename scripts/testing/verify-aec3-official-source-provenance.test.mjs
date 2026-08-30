import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  assertPinnedVcpkgWebRtcPort,
  collectAec3SourceProvenanceViolations,
} from './verify-aec3-official-source-provenance.mjs';

function hash(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

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
