import crypto from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OFFICIAL_AEC3_PROVENANCE = Object.freeze({
  repository: 'https://webrtc.googlesource.com/src',
  commit: 'aa217206b9ce8b929dc56d112d670a5931ef8cc1',
  vcpkgBaseline: 'ea1a7396b05637a53bf23c078647ecc0edee4b80',
  vcpkgPortTree: 'cc451e2a9de306d0d259c7dc6b8808fea8b1d94f',
  sources: Object.freeze([
    Object.freeze({
      upstreamPath: 'api/audio/echo_detector_creator.cc',
      vendoredPath: 'upstream/webrtc/api/audio/echo_detector_creator.cc',
      sha256: 'd8d6fbc0858d6a6e972f6e1f46012d99460d49b2d21f38a485bb35dd9d9c9491',
    }),
    Object.freeze({
      upstreamPath: 'modules/audio_processing/residual_echo_detector.cc',
      vendoredPath: 'upstream/webrtc/modules/audio_processing/residual_echo_detector.cc',
      sha256: '45b5a815cbc0e32c8f0705f742db93e9f0063c6777ea874c5d90c32b3f03e355',
    }),
    Object.freeze({
      upstreamPath: 'modules/audio_processing/echo_detector/circular_buffer.cc',
      vendoredPath: 'upstream/webrtc/modules/audio_processing/echo_detector/circular_buffer.cc',
      sha256: 'a2a4837632a6cdc7a3ec04bbd1db7cf8c347c6377e2dae2c79510029aef33c82',
    }),
    Object.freeze({
      upstreamPath: 'modules/audio_processing/echo_detector/mean_variance_estimator.cc',
      vendoredPath: 'upstream/webrtc/modules/audio_processing/echo_detector/mean_variance_estimator.cc',
      sha256: '6b9c943b4b81f4359ffc8c4f3301fbf5402a9485f81373a9a29f4025c9d3cc47',
    }),
    Object.freeze({
      upstreamPath: 'modules/audio_processing/echo_detector/moving_max.cc',
      vendoredPath: 'upstream/webrtc/modules/audio_processing/echo_detector/moving_max.cc',
      sha256: 'ecc954ebb526ca2d32eedf9a277cdedb3132765c40cf0cc8082795ff1270de4b',
    }),
    Object.freeze({
      upstreamPath: 'modules/audio_processing/echo_detector/normalized_covariance_estimator.cc',
      vendoredPath: 'upstream/webrtc/modules/audio_processing/echo_detector/normalized_covariance_estimator.cc',
      sha256: '2c2de0c8897367666800441e247b87debeab66ba2e02855b631f272fc48863fe',
    }),
  ]),
});

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function normalizePath(path) {
  return path.replaceAll('\\', '/').replace(/^\.\//u, '');
}

function readText(path, violations, description) {
  if (!existsSync(path)) {
    violations.push(`missing ${description}: ${path}`);
    return '';
  }
  return readFileSync(path, 'utf8');
}

function cmakeLibrarySources(cmake, violations) {
  const declaration = cmake.match(
    /add_library\s*\(\s*omni_webrtc_aec3_ffi\s+STATIC(?<sources>[\s\S]*?)\)/u,
  );
  if (!declaration?.groups?.sources) {
    violations.push('CMake does not declare omni_webrtc_aec3_ffi as an explicit STATIC source list');
    return [];
  }
  return declaration.groups.sources
    .replaceAll(/#[^\r\n]*/gu, '')
    .split(/\s+/u)
    .map((token) => normalizePath(token.replace(/^['"]|['"]$/gu, '')))
    .filter(Boolean);
}

function listCxxSources(root) {
  if (!existsSync(root)) return [];
  const pending = [root];
  const files = [];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      if (entry.isFile() && /\.(?:cc|cpp|cxx)$/iu.test(entry.name)) files.push(path);
    }
  }
  return files;
}

function verifyNoLocalFactoryRewrite(ffiRoot, provenance, violations) {
  const officialCreator = normalizePath(provenance.sources[0].vendoredPath);
  const officialResidual = normalizePath(provenance.sources[1].vendoredPath);
  for (const path of listCxxSources(ffiRoot)) {
    const ffiRelativePath = normalizePath(relative(ffiRoot, path));
    const source = readFileSync(path, 'utf8');
    const definesFactory = /\bCreateEchoDetector\s*\([^;{}]*\)\s*\{/u.test(source);
    const definesResidual = /\bclass\s+ResidualEchoDetector[A-Za-z0-9_]*\b/u.test(source)
      || /\bResidualEchoDetector::/u.test(source);
    if (definesFactory && ffiRelativePath !== officialCreator) {
      violations.push(
        `local CreateEchoDetector factory is forbidden: ${ffiRelativePath}; use the hash-pinned official creator`,
      );
    }
    if (definesResidual && ffiRelativePath !== officialResidual) {
      violations.push(
        `local ResidualEchoDetector rewrite is forbidden: ${ffiRelativePath}; use the hash-pinned official implementation`,
      );
    }
  }
}

function verifyNativeFixture(fixture, violations) {
  if (!/kTotalFrames\s*=\s*600\s*;/u.test(fixture)) {
    violations.push('native fixture must process exactly 600 deterministic frames');
  }
  if (!/isfinite\s*\(\s*stats\.residual_echo_likelihood\s*\)/u.test(fixture)
      || !/stats\.residual_echo_likelihood\s*<\s*0\.0/u.test(fixture)
      || !/stats\.residual_echo_likelihood\s*>\s*1\.0/u.test(fixture)) {
    violations.push('native fixture must require finite residualEchoLikelihood in [0,1]');
  }
  if (!/omni_webrtc_aec3_reset\s*\(\s*aec\s*\)/u.test(fixture)
      || !/reset_count\s*!=\s*1/u.test(fixture)) {
    violations.push('native fixture must execute reset and require reset_count == 1');
  }
}

export function collectAec3SourceProvenanceViolations(
  workspaceRoot,
  provenance = OFFICIAL_AEC3_PROVENANCE,
) {
  const workspace = resolve(workspaceRoot);
  const crateRoot = join(workspace, 'crates', 'omni-webrtc-aec3');
  const ffiRoot = join(crateRoot, 'ffi');
  const violations = [];

  let vcpkg = null;
  try {
    vcpkg = JSON.parse(readText(join(crateRoot, 'vcpkg.json'), violations, 'AEC3 vcpkg manifest'));
  } catch (error) {
    violations.push(`AEC3 vcpkg manifest is invalid JSON: ${error.message}`);
  }
  if (vcpkg?.['builtin-baseline'] !== provenance.vcpkgBaseline) {
    violations.push(
      `vcpkg baseline mismatch: expected=${provenance.vcpkgBaseline} actual=${vcpkg?.['builtin-baseline'] ?? 'missing'}`,
    );
  }

  const cmake = readText(join(ffiRoot, 'CMakeLists.txt'), violations, 'AEC3 CMake source list');
  const actualSources = cmakeLibrarySources(cmake, violations);
  const expectedSources = [
    'omni_webrtc_aec3.cc',
    ...provenance.sources.map(({ vendoredPath }) => normalizePath(vendoredPath)),
  ];
  for (const expected of expectedSources) {
    if (!actualSources.includes(expected)) violations.push(`CMake is missing required source: ${expected}`);
  }
  for (const actual of actualSources) {
    if (!expectedSources.includes(actual)) violations.push(`CMake compiles unapproved source: ${actual}`);
  }
  if (actualSources.length !== new Set(actualSources).size) {
    violations.push('CMake source list contains duplicate compilation units');
  }

  for (const source of provenance.sources) {
    const path = join(ffiRoot, ...normalizePath(source.vendoredPath).split('/'));
    if (!existsSync(path)) {
      violations.push(
        `missing official WebRTC source: ${source.vendoredPath} (${provenance.repository}/+/${provenance.commit}/${source.upstreamPath})`,
      );
      continue;
    }
    const actualHash = sha256(readFileSync(path));
    if (actualHash !== source.sha256) {
      violations.push(
        `official source hash mismatch: ${source.vendoredPath} expected=${source.sha256} actual=${actualHash}`,
      );
    }
  }

  verifyNoLocalFactoryRewrite(ffiRoot, provenance, violations);

  const buildScript = readText(join(crateRoot, 'build.rs'), violations, 'AEC3 Cargo build script');
  if (!buildScript.includes('cargo:rerun-if-changed=ffi/upstream/webrtc')) {
    violations.push('build.rs must rerun when the pinned official WebRTC sources change');
  }

  const fixture = readText(
    join(ffiRoot, 'omni_webrtc_aec3_fixture.cc'),
    violations,
    'deterministic AEC3 native fixture',
  );
  verifyNativeFixture(fixture, violations);
  return violations;
}

export function assertPinnedVcpkgWebRtcPort(
  { baseline, portTree, portfile },
  provenance = OFFICIAL_AEC3_PROVENANCE,
) {
  const violations = [];
  if (baseline !== provenance.vcpkgBaseline) {
    violations.push(`checked-out vcpkg baseline mismatch: expected=${provenance.vcpkgBaseline} actual=${baseline}`);
  }
  if (portTree !== provenance.vcpkgPortTree) {
    violations.push(`webrtc port tree mismatch: expected=${provenance.vcpkgPortTree} actual=${portTree}`);
  }
  const escapedCommit = provenance.commit.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  if (!new RegExp(`set\\(WEBRTC_SOURCE_REF\\s+"${escapedCommit}"\\)`, 'u').test(portfile)) {
    violations.push(`webrtc port does not pin official commit ${provenance.commit}`);
  }
  if (violations.length > 0) {
    throw new Error(`AEC3 vcpkg provenance verification failed:\n- ${violations.join('\n- ')}`);
  }
}

export function verifyAec3OfficialSourceProvenance(workspaceRoot) {
  const violations = collectAec3SourceProvenanceViolations(workspaceRoot);
  if (violations.length > 0) {
    throw new Error(
      `AEC3 official-source provenance verification failed `
      + `(upstream=${OFFICIAL_AEC3_PROVENANCE.repository} commit=${OFFICIAL_AEC3_PROVENANCE.commit}):\n`
      + `- ${violations.join('\n- ')}`,
    );
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const workspace = resolve(import.meta.dirname, '..', '..');
  verifyAec3OfficialSourceProvenance(workspace);
  console.log(
    `AEC3 official-source provenance passed `
    + `(commit=${OFFICIAL_AEC3_PROVENANCE.commit}, portTree=${OFFICIAL_AEC3_PROVENANCE.vcpkgPortTree}).`,
  );
}
