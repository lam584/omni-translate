import fs from 'node:fs';
import path from 'node:path';

import { verifyConfigPaths } from './verify-config-paths.mjs';

const rootDir = process.cwd();
const protocolVersion = '2026-08-27-audio-routing-v8';
const legacyBridgeName = ['bridge', 'service'].join('-');
const legacyBridgePath = path.join('apps', legacyBridgeName);
const legacyBridgePackage = ['@omni', legacyBridgeName].join('/');
const legacyCoverageStep = ['legacy-node', 'bridge'].join('-');

const failures = [];

function fail(message) {
  failures.push(message);
}

function fullPath(relativePath) {
  return path.join(rootDir, relativePath);
}

function readText(relativePath) {
  return fs.readFileSync(fullPath(relativePath), 'utf8');
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function assertTextMatch(relativePath, pattern, label) {
  const text = readText(relativePath);
  if (!pattern.test(text)) {
    fail(`${label} is not pinned to ${protocolVersion}: ${relativePath}`);
  }
}

function assertJsonValue(relativePath, pointer, expected, label) {
  const payload = readJson(relativePath);
  const actual = pointer.reduce((value, key) => value?.[key], payload);
  if (actual !== expected) {
    fail(`${label} mismatch in ${relativePath}: expected=${expected}, actual=${actual}`);
  }
}

function collectFiles(dir, predicate = () => true) {
  if (!fs.existsSync(dir)) {
    return [];
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return collectFiles(entryPath, predicate);
    }
    return predicate(entryPath) ? [entryPath] : [];
  });
}

if (fs.existsSync(fullPath(legacyBridgePath))) {
  fail(`Removed legacy bridge workspace still exists: ${legacyBridgePath}`);
}

const rootPackage = readJson('package.json');
const tauriConfig = readJson(path.join('apps', 'desktop', 'src-tauri', 'tauri.conf.json'));
const vitestSetupPath = path.join('apps', 'desktop', 'src', 'test-setup.ts');

const watchReadinessContract = readJson(path.join('contracts', 'watch-mode-readiness-v2.json'));
const watchReadinessRust = readText(path.join('apps', 'desktop', 'src-tauri', 'src', 'watch_mode_diagnostic', 'readiness.rs'));
const watchRunnerPowerShell = readText(path.join('scripts', 'testing', 'lib', 'powershell', 'Omni.Testing.WatchMode.Readiness.psm1'));
if (!watchReadinessRust.includes(`const SCHEMA_VERSION: &str = "${watchReadinessContract.schemaVersion}"`)) {
  fail('Desktop Watch readiness writer is not pinned to contracts/watch-mode-readiness-v2.json.');
}
if (!watchRunnerPowerShell.includes(`$status.schemaVersion -ne '${watchReadinessContract.schemaVersion}'`)) {
  fail('PowerShell Watch runner is not pinned to contracts/watch-mode-readiness-v2.json.');
}
for (const state of watchReadinessContract.states) {
  if (!watchReadinessRust.includes(`"${state}"`)) {
    fail(`Desktop Watch readiness writer is missing contract state: ${state}`);
  }
}

if (typeof tauriConfig.app?.security?.csp !== 'string' || !tauriConfig.app.security.csp.trim()) {
  fail('Desktop Tauri CSP must be an explicit non-empty string.');
}
if (tauriConfig.bundle?.active !== true) {
  fail('Desktop bundle packaging must be enabled for release artifacts.');
}
if (!fs.existsSync(fullPath(vitestSetupPath))) {
  fail(`Vitest setup file is missing: ${vitestSetupPath}`);
}
const removedScripts = [
  `check:${legacyBridgeName}`,
  `build:${legacyBridgeName}`,
  `test:${legacyBridgeName}`,
  `test:${legacyBridgeName}-coverage`,
];
for (const scriptName of removedScripts) {
  if (rootPackage.scripts?.[scriptName]) {
    fail(`Removed root script is still present: ${scriptName}`);
  }
}

assertTextMatch(
  path.join('crates', 'omni-bridge-protocol', 'src', 'lib.rs'),
  new RegExp(`BRIDGE_PROTOCOL_VERSION:\\s*&str\\s*=\\s*"${protocolVersion}"`),
  'shared bridge protocol crate',
);
assertTextMatch(
  path.join('apps', 'desktop', 'src', 'schema', 'driver-bridge-contract.ts'),
  new RegExp(`DriverBridgeProtocolVersion\\s*=\\s*'${protocolVersion}'`),
  'desktop TypeScript bridge contract',
);
assertTextMatch(
  path.join('apps', 'desktop', 'src', 'schema', 'generated', 'driver-bridge-contract.ts'),
  /export type TranslationStreamState = "start" \| "chunk" \| "end" \| "abort";/,
  'generated physical translation stream states',
);
assertTextMatch(
  path.join('apps', 'desktop', 'src', 'defaults', 'app-config.ts'),
  new RegExp(`protocolVersion:\\s*'${protocolVersion}'`),
  'desktop config mock protocol',
);
assertTextMatch(
  path.join('apps', 'desktop', 'src-tauri', 'src', 'bridge', 'ipc.rs'),
  /protocol_version:\s*omni_bridge_protocol::BRIDGE_PROTOCOL_VERSION\.to_string\(\)/,
  'desktop Rust bridge init protocol',
);
assertJsonValue(
  path.join('apps', 'desktop', 'src-tauri', 'defaults', 'app-config.default.json'),
  ['driver', 'protocolVersion'],
  protocolVersion,
  'desktop default config protocol',
);
assertJsonValue(
  path.join('drivers', 'windows-virtual-mic', 'src', 'driver_package_contract.json'),
  ['protocolVersion'],
  protocolVersion,
  'driver package protocol',
);

for (const relativePath of [
  path.join('scripts', 'testing', 'lib', 'powershell', 'Omni.Testing.WatchMode.Bridge.psm1'),
  path.join('scripts', 'testing', 'lib', 'powershell', 'Omni.Testing.WatchMode.AudioCapture.psm1'),
  path.join('scripts', 'installer', 'install-development-driver.ps1'),
  path.join('scripts', 'installer', 'build-sysvad-driver.ps1'),
]) {
  assertTextMatch(relativePath, new RegExp(`protocolVersion\\s*=\\s*'${protocolVersion}'`), 'script protocol');
}

// devices.aecEnabled must keep a real native consumer: the desktop schema maps the
// draft field, and the Rust audio engine reads it into RouteSpec to gate echo cancel.
{
  const schemaPath = path.join('apps', 'desktop', 'src', 'schema', 'config.ts');
  const enginePath = path.join('apps', 'desktop', 'src-tauri', 'src', 'audio', 'engine', 'mod.rs');
  const schemaText = readText(schemaPath);
  const engineText = readText(enginePath);
  if (!/draftPath:\s*'devices\.aecEnabled'/.test(schemaText)) {
    fail(`devices.aecEnabled schema mapping is missing in ${schemaPath}`);
  }
  if (!engineText.includes('/devices/aecEnabled')) {
    fail(`devices.aecEnabled has no native consumer: pointer "/devices/aecEnabled" not found in ${enginePath}`);
  }
  if (!/fn echo_cancel_enabled[\s\S]{0,200}?aec_enabled/.test(engineText)) {
    fail(`devices.aecEnabled must participate in echo_cancel_enabled() in ${enginePath}`);
  }
}

// ---------------------------------------------------------------------------
// Expected driver/bridge version pins: every hard-coded carrier of the
// expected driver version and expected bridge version must move together.
const expectedDriverVersion = '0.10.0-dev';
const expectedBridgeVersion = '0.1.0';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function assertVersionPin(relativePath, pattern, expected, label) {
  const text = readText(relativePath);
  if (!pattern.test(text)) {
    fail(`${label} is not pinned to ${expected}: ${relativePath}`);
  }
}

const driverVersionToken = escapeRegExp(expectedDriverVersion);
const bridgeVersionToken = escapeRegExp(expectedBridgeVersion);

const driverVersionPins = [
  [
    path.join('apps', 'desktop', 'src-tauri', 'src', 'bridge', 'contracts.rs'),
    new RegExp(`expected_driver_version:\\s*"${driverVersionToken}"`),
    'desktop Rust bridge snapshot expected driver version',
  ],
  [
    path.join('apps', 'desktop', 'src-tauri', 'src', 'bridge', 'installer.rs'),
    new RegExp(`"${driverVersionToken}"`),
    'desktop Rust installer driver version fixtures',
  ],
  [
    path.join('apps', 'desktop', 'src', 'defaults', 'app-config.ts'),
    new RegExp(`expectedDriverVersion:\\s*'${driverVersionToken}'`),
    'desktop config mock expected driver version',
  ],
  [
    path.join('apps', 'desktop', 'src', 'defaults', 'runtime-shell.ts'),
    new RegExp(`expectedDriverVersion:\\s*'${driverVersionToken}'`),
    'desktop runtime shell mock expected driver version',
  ],
  [
    path.join('apps', 'bridge-service-native', 'src', 'lib.rs'),
    new RegExp(`"${driverVersionToken}"`),
    'native bridge service driver version fixtures',
  ],
  [
    path.join('apps', 'bridge-service-native', 'src', 'bin', 'omni-physical-output-probe.rs'),
    new RegExp(`"expectedDriverVersion":\\s*"${driverVersionToken}"`),
    'physical output probe expected driver version',
  ],
  [
    path.join('scripts', 'testing', 'lib', 'powershell', 'Omni.Testing.WatchMode.Bridge.psm1'),
    new RegExp(`expectedDriverVersion\\s*=\\s*'${driverVersionToken}'`),
    'watch mode live script expected driver version',
  ],
  [
    path.join('scripts', 'testing', 'lib', 'powershell', 'Omni.Testing.WatchMode.PlatformOperations.psm1'),
    new RegExp(`-DriverVersion ${driverVersionToken}`),
    'watch mode live script -DriverVersion argument',
  ],
  ['package.json', new RegExp(`-DriverVersion ${driverVersionToken} `), 'root package driver scripts driver version'],
];
for (const [relativePath, pattern, label] of driverVersionPins) {
  assertVersionPin(relativePath, pattern, expectedDriverVersion, label);
}
assertJsonValue(
  path.join('apps', 'desktop', 'src-tauri', 'defaults', 'app-config.default.json'),
  ['driver', 'expectedDriverVersion'],
  expectedDriverVersion,
  'desktop default config expected driver version',
);
assertJsonValue(
  path.join('drivers', 'windows-virtual-mic', 'src', 'driver_manifest.json'),
  ['version'],
  expectedDriverVersion,
  'driver manifest version',
);
assertJsonValue(
  path.join('drivers', 'windows-virtual-mic', 'tests', 'fixtures', 'driver-install-state.sample.json'),
  ['driverVersion'],
  expectedDriverVersion,
  'driver install-state sample driver version',
);

const bridgeVersionPins = [
  [
    path.join('apps', 'desktop', 'src-tauri', 'src', 'bridge', 'contracts.rs'),
    new RegExp(`expected_bridge_version:\\s*"${bridgeVersionToken}"`),
    'desktop Rust bridge snapshot expected bridge version',
  ],
  [
    path.join('apps', 'desktop', 'src-tauri', 'src', 'bridge', 'contracts.rs'),
    new RegExp(`bridge_version:\\s*"${bridgeVersionToken}"`),
    'desktop Rust bridge snapshot bridge version',
  ],
  [
    path.join('apps', 'desktop', 'src', 'defaults', 'app-config.ts'),
    new RegExp(`expectedBridgeVersion:\\s*'${bridgeVersionToken}'`),
    'desktop config mock expected bridge version',
  ],
  [
    path.join('apps', 'desktop', 'src', 'defaults', 'runtime-shell.ts'),
    new RegExp(`expectedBridgeVersion:\\s*'${bridgeVersionToken}'`),
    'desktop runtime shell mock expected bridge version',
  ],
  [
    path.join('apps', 'desktop', 'src', 'defaults', 'runtime-shell.ts'),
    new RegExp(`bridgeVersion:\\s*'${bridgeVersionToken}'`),
    'desktop runtime shell mock bridge version',
  ],
  [
    path.join('apps', 'bridge-service-native', 'src', 'windows', 'mod.rs'),
    new RegExp(`"${bridgeVersionToken}"`),
    'native bridge service default bridge version',
  ],
  [
    path.join('apps', 'bridge-service-native', 'Cargo.toml'),
    new RegExp(`^version = "${bridgeVersionToken}"`, 'm'),
    'native bridge service crate version',
  ],
  [
    path.join('apps', 'bridge-service-native', 'src', 'bin', 'omni-physical-output-probe.rs'),
    new RegExp(`"expectedBridgeVersion":\\s*"${bridgeVersionToken}"`),
    'physical output probe expected bridge version',
  ],
  [
    path.join('scripts', 'testing', 'lib', 'powershell', 'Omni.Testing.WatchMode.Bridge.psm1'),
    new RegExp(`expectedBridgeVersion\\s*=\\s*'${bridgeVersionToken}'`),
    'watch mode live script expected bridge version',
  ],
  [
    path.join('scripts', 'testing', 'lib', 'powershell', 'Omni.Testing.WatchMode.PlatformOperations.psm1'),
    new RegExp(`-BridgeVersion ${bridgeVersionToken}`),
    'watch mode live script -BridgeVersion argument',
  ],
  ['package.json', new RegExp(`-BridgeVersion ${bridgeVersionToken} `), 'root package driver scripts bridge version'],
];
for (const [relativePath, pattern, label] of bridgeVersionPins) {
  assertVersionPin(relativePath, pattern, expectedBridgeVersion, label);
}
assertJsonValue(
  path.join('apps', 'desktop', 'src-tauri', 'defaults', 'app-config.default.json'),
  ['driver', 'expectedBridgeVersion'],
  expectedBridgeVersion,
  'desktop default config expected bridge version',
);
assertJsonValue(
  path.join('drivers', 'windows-virtual-mic', 'tests', 'fixtures', 'driver-install-state.sample.json'),
  ['bridgeVersion'],
  expectedBridgeVersion,
  'driver install-state sample bridge version',
);

// ---------------------------------------------------------------------------
// Cross-process event channels. The Rust side is enumerated automatically so
// a new `..._EVENT` constant cannot ship unguarded; the pinned set below is
// the governance anchor that catches a silent rename on both sides at once.
// Adding a Rust event constant therefore requires: a TS constant with the
// same wire value, plus an entry here.
const EXPECTED_CROSS_PROCESS_EVENTS = [
  'audio://snapshot',
  'audio://subtitle-delta',
  'benchmark://progress',
  'config://draft-updated',
  'credential://direct-result',
  'history://changed',
  'history://playback',
  'runtime://notification',
  'runtime://snapshot',
];

function collectEventConstants(rootPath, pattern, filePredicate) {
  const constants = new Map();
  for (const filePath of collectFiles(rootPath, filePredicate)) {
    const source = fs.readFileSync(filePath, 'utf8');
    for (const match of source.matchAll(pattern)) {
      constants.set(match[1], { value: match[2], file: path.relative(rootDir, filePath) });
    }
  }
  return constants;
}

const rustEventConstants = collectEventConstants(
  path.join(rootDir, 'apps', 'desktop', 'src-tauri', 'src'),
  /(?:pub )?const ([A-Z][A-Z0-9_]*_EVENT): &str = "([^"]+)"/g,
  (filePath) => filePath.endsWith('.rs'),
);
const tsEventConstants = collectEventConstants(
  path.join(rootDir, 'apps', 'desktop', 'src'),
  /export const ([A-Z][A-Z0-9_]*_EVENT) = '([^']+)'/g,
  (filePath) => /\.(?:ts|tsx)$/.test(filePath) && !/\.test\.(?:ts|tsx)$/.test(filePath),
);

const rustEventValues = [...new Set([...rustEventConstants.values()].map((entry) => entry.value))].sort();
if (JSON.stringify(rustEventValues) !== JSON.stringify([...EXPECTED_CROSS_PROCESS_EVENTS].sort())) {
  fail(
    `Rust cross-process event set drifted from the pinned manifest: pinned=${EXPECTED_CROSS_PROCESS_EVENTS.join(',')} actual=${rustEventValues.join(',')}. `
    + 'Update EXPECTED_CROSS_PROCESS_EVENTS together with the TypeScript listener constant.',
  );
}

const tsEventValues = new Set([...tsEventConstants.values()].map((entry) => entry.value));
for (const [name, rustEntry] of rustEventConstants) {
  if (!tsEventValues.has(rustEntry.value)) {
    fail(`Rust event ${name}="${rustEntry.value}" (${rustEntry.file}) has no TypeScript constant with the same wire value`);
  }
  const tsEntry = tsEventConstants.get(name);
  if (tsEntry && tsEntry.value !== rustEntry.value) {
    fail(`Event constant ${name} disagrees: Rust='${rustEntry.value}' (${rustEntry.file}) vs TS='${tsEntry.value}' (${tsEntry.file})`);
  }
}

// ---------------------------------------------------------------------------
// Tagged-enum field renaming: an internally-tagged serde enum whose struct
// variants carry inline fields must not declare `rename_all` without
// `rename_all_fields`. `rename_all` only renames the VARIANT tags, so a
// multi-word field would silently stay snake_case on the wire while the
// renderer sends camelCase — the exact drift class behind e7beb57 (an Option
// field swallowed its payload for ~12 days while manual testing looked fine).
export function findTaggedEnumRenameGaps(source, relativePath) {
  const gaps = [];
  const enumPattern = /#\[serde\(([^)]*)\)\]\s*(?:#\[[^\]]*\]\s*)*pub(?:\(crate\))?\s+enum\s+(\w+)\s*\{([\s\S]*?)\n\}/g;
  for (const match of source.matchAll(enumPattern)) {
    const [, serdeAttrs, enumName, body] = match;
    if (!/\btag\s*=/.test(serdeAttrs)) continue;
    const hasStructVariant = /^\s{4}\w+\s*\{/m.test(body);
    if (!hasStructVariant) continue;
    if (/\brename_all\s*=/.test(serdeAttrs) && !/\brename_all_fields\s*=/.test(serdeAttrs)) {
      gaps.push(`${relativePath}: tagged enum ${enumName} has struct variants with rename_all but no rename_all_fields`);
    }
  }
  return gaps;
}

{
  const rustRoots = [
    path.join(rootDir, 'apps', 'desktop', 'src-tauri', 'src'),
    path.join(rootDir, 'apps', 'bridge-service-native', 'src'),
    path.join(rootDir, 'crates'),
  ];
  for (const rustRoot of rustRoots) {
    for (const filePath of collectFiles(rustRoot, (candidate) => candidate.endsWith('.rs'))) {
      const relativePath = path.relative(rootDir, filePath);
      for (const gap of findTaggedEnumRenameGaps(fs.readFileSync(filePath, 'utf8'), relativePath)) {
        fail(gap);
      }
    }
  }
  // Self-check: the pattern must actually fire on a violating enum, so the
  // guard cannot rot into a regex that matches nothing.
  const violating = [
    '#[serde(tag = "action", rename_all = "camelCase")]',
    'pub enum SelfCheckCommand {',
    '    DoThing {',
    '        some_field: bool,',
    '    },',
    '}',
  ].join('\n');
  if (findTaggedEnumRenameGaps(violating, 'self-check').length !== 1) {
    fail('tagged-enum rename lint self-check failed: the guard no longer detects a known violation');
  }
}

// ---------------------------------------------------------------------------
// Field-level contract validation moved to generated TypeScript files: the
// contract_export cargo test (apps/desktop/src-tauri/src/contract_export.rs)
// fails when apps/desktop/src/schema/generated/ no longer matches the Rust
// contract structs, and tsc fails when consumers disagree with the generated
// shapes. This script keeps only the version/event-name pins and governance
// checks above and below.

// Stable user-facing error codes have a small language-neutral manifest,
// categorized by domain (contracts/error-codes.json). session/audio codes are
// user-facing: the TypeScript union and presentation map must cover them
// exactly. bridge codes are wire codes: the omni-bridge-protocol crate pins
// them via bridge_error_codes_match_the_shared_contract_manifest. Every code
// must additionally be emitted by non-test implementation code — appearances
// inside comments or test modules do not count.
{
  const manifest = readJson(path.join('contracts', 'error-codes.json'));
  for (const [category, prefix] of [['session', 'session.'], ['audio', 'audio.'], ['bridge', 'bridge.']]) {
    if (!Array.isArray(manifest[category]) || manifest[category].length === 0) {
      fail(`contracts/error-codes.json is missing a non-empty ${category} array`);
      continue;
    }
    for (const code of manifest[category]) {
      if (!code.startsWith(prefix)) {
        fail(`contracts/error-codes.json ${category} entry has the wrong prefix: ${code}`);
      }
    }
  }

  // Drop everything below the first #[cfg(test)] (same convention as
  // verify-config-paths) and every pure comment line, so "emitted by the
  // implementation" means emitted by shipping code.
  const stripRustTestCode = (source) => source.split('#[cfg(test)]')[0];
  const stripCommentLines = (source) => source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trimStart();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    })
    .join('\n');
  // Word-boundary match: the code must stand alone (quoted literal or inside
  // a diagnostic message), not be a substring of a longer identifier.
  const emissionPattern = (code) => new RegExp(`(?<![\\w.-])${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`);

  const sessionImplementationText = [
    ...collectFiles(path.join(rootDir, 'apps', 'desktop', 'src'), (filePath) => /\.(?:ts|tsx)$/.test(filePath)
      && !/\.test\.(?:ts|tsx)$/.test(filePath)
      && !filePath.includes(`${path.sep}mocks${path.sep}`)
      && !filePath.endsWith(path.join('schema', 'audio-runtime.ts'))
      && !filePath.endsWith(path.join('utils', 'session-error-presentation.ts')))
      .map((filePath) => stripCommentLines(fs.readFileSync(filePath, 'utf8'))),
    ...collectFiles(path.join(rootDir, 'apps', 'desktop', 'src-tauri', 'src'), (filePath) => filePath.endsWith('.rs'))
      .map((filePath) => stripCommentLines(stripRustTestCode(fs.readFileSync(filePath, 'utf8')))),
  ].join('\n');

  const expectedCodes = [...manifest.session, ...manifest.audio];
  const schemaText = readText(path.join('apps', 'desktop', 'src', 'schema', 'audio-runtime.ts'));
  const presentationText = readText(path.join('apps', 'desktop', 'src', 'utils', 'session-error-presentation.ts'));
  const unionBlock = schemaText.match(/export type SessionErrorCode\s*=([\s\S]*?);/)?.[1] ?? '';
  const actualCodes = [...unionBlock.matchAll(/'((?:session|audio)\.[^']+)'/g)].map((match) => match[1]).sort();
  const expectedSorted = [...expectedCodes].sort();
  if (JSON.stringify(actualCodes) !== JSON.stringify(expectedSorted)) {
    fail(`SessionErrorCode differs from contracts/error-codes.json: expected=${expectedSorted.join(',')} actual=${actualCodes.join(',')}`);
  }
  for (const code of expectedCodes) {
    if (!presentationText.includes(`'${code}'`)) fail(`Error presentation missing code: ${code}`);
    if (!emissionPattern(code).test(sessionImplementationText)) {
      fail(`No non-test implementation emits stable error code: ${code}`);
    }
  }

  const bridgeImplementationText = [
    ...collectFiles(path.join(rootDir, 'apps', 'bridge-service-native', 'src'), (filePath) => filePath.endsWith('.rs')),
    ...collectFiles(path.join(rootDir, 'apps', 'desktop', 'src-tauri', 'src', 'bridge'), (filePath) => filePath.endsWith('.rs')),
  ].map((filePath) => stripCommentLines(stripRustTestCode(fs.readFileSync(filePath, 'utf8')))).join('\n');
  for (const code of manifest.bridge) {
    if (!emissionPattern(code).test(bridgeImplementationText)) {
      fail(`No non-test bridge implementation emits stable error code: ${code}`);
    }
  }

  // Self-check: the emission matcher must keep rejecting comment-only and
  // test-only appearances, so the guard cannot rot into substring matching.
  const commentOnly = stripCommentLines('// "session.fake-code" mentioned in prose');
  const testOnly = stripRustTestCode('#[cfg(test)]\nmod tests { const X: &str = "session.fake-code"; }');
  if (emissionPattern('session.fake-code').test(commentOnly) || emissionPattern('session.fake-code').test(testOnly)) {
    fail('error-code emission self-check failed: comment/test appearances still count as implementation');
  }
}

// ---------------------------------------------------------------------------
// Config-path guard (阶段6 方案B): every JSON-pointer literal the Rust side
// touches must resolve in the default config document, be an allowed
// wire-protocol read, or carry documentation in verify-config-paths.mjs.
{
  const { failures: configPathFailures, warnings: configPathWarnings } = verifyConfigPaths();
  for (const warning of configPathWarnings) {
    console.warn(`verify-contracts: ${warning}`);
  }
  failures.push(...configPathFailures);
}

const governanceFiles = [
  'package.json',
  'package-lock.json',
  'README.md',
  path.join('i18n', 'README_en.md'),
  ...collectFiles(path.join(rootDir, 'scripts'), (filePath) => /\.(?:mjs|ps1|md)$/i.test(filePath)).map((filePath) =>
    path.relative(rootDir, filePath),
  ),
  ...collectFiles(path.join(rootDir, 'docs'), (filePath) => /\.md$/i.test(filePath)).map((filePath) =>
    path.relative(rootDir, filePath),
  ),
];

for (const relativePath of governanceFiles) {
  if (relativePath === path.join('scripts', 'testing', 'verify-contracts.mjs')) {
    continue;
  }
  const resolved = fullPath(relativePath);
  if (!fs.existsSync(resolved)) {
    continue;
  }

  const text = readText(relativePath);
  const normalizedText = text.replace(/\\/g, '/');
  const legacyPathToken = ['apps', legacyBridgeName].join('/');
  const legacyPathPattern = new RegExp(`${legacyPathToken.replace(/\//g, '\\/')}(?:/|$)`);
  if (legacyPathPattern.test(normalizedText)) {
    fail(`Legacy bridge path reference found in ${relativePath}`);
  }
  if (text.includes(legacyBridgePackage)) {
    fail(`Legacy bridge package reference found in ${relativePath}`);
  }
  if (text.includes(legacyCoverageStep)) {
    fail(`Legacy bridge coverage step found in ${relativePath}`);
  }
  for (const scriptName of removedScripts) {
    const legacyScriptRun = new RegExp(`npm\\s+run\\s+${scriptName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!-native)`);
    if (legacyScriptRun.test(text)) {
      fail(`Removed legacy bridge script reference found in ${relativePath}: ${scriptName}`);
    }
  }
}

if (failures.length) {
  console.error('Contract verification failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(
  `Contract verification passed for protocol ${protocolVersion} (driver ${expectedDriverVersion}, bridge ${expectedBridgeVersion}).`,
);
