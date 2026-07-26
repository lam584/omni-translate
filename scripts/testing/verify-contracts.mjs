import fs from 'node:fs';
import path from 'node:path';

import { verifyConfigPaths } from './verify-config-paths.mjs';

const rootDir = process.cwd();
const protocolVersion = '2026-06-02-loopback-v2';
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
  path.join('apps', 'desktop', 'src', 'defaults', 'app-config.ts'),
  new RegExp(`protocolVersion:\\s*'${protocolVersion}'`),
  'desktop config mock protocol',
);
assertTextMatch(
  path.join('apps', 'desktop', 'src', 'mocks', 'driver-runtime.ts'),
  new RegExp(`protocolVersion:\\s*'${protocolVersion}'`),
  'desktop driver runtime mock protocol',
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
  path.join('drivers', 'windows-virtual-mic', 'package', 'driver-package.json'),
  ['protocolVersion'],
  protocolVersion,
  'driver package protocol',
);

for (const relativePath of [
  path.join('scripts', 'testing', 'run-watch-mode-live.ps1'),
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
    path.join('scripts', 'testing', 'run-watch-mode-live.ps1'),
    new RegExp(`expectedDriverVersion\\s*=\\s*'${driverVersionToken}'`),
    'watch mode live script expected driver version',
  ],
  [
    path.join('scripts', 'testing', 'run-watch-mode-live.ps1'),
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
    path.join('scripts', 'testing', 'run-watch-mode-live.ps1'),
    new RegExp(`expectedBridgeVersion\\s*=\\s*'${bridgeVersionToken}'`),
    'watch mode live script expected bridge version',
  ],
  [
    path.join('scripts', 'testing', 'run-watch-mode-live.ps1'),
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
// Event name pins: the TS and Rust literals for cross-process event channels
// must stay identical (and match the pinned value).
function extractLiteral(relativePath, pattern, label) {
  const match = pattern.exec(readText(relativePath));
  if (!match) {
    fail(`${label} literal not found in ${relativePath}`);
    return null;
  }
  return match[1];
}

const runtimeCoreSchemaPath = path.join('apps', 'desktop', 'src', 'schema', 'runtime-core.ts');

const eventNamePins = [
  {
    label: 'runtime snapshot event',
    expected: 'runtime://snapshot',
    ts: [runtimeCoreSchemaPath, /export const RUNTIME_SNAPSHOT_EVENT = '([^']+)'/],
    rust: [
      path.join('apps', 'desktop', 'src-tauri', 'src', 'runtime', 'events.rs'),
      /pub const RUNTIME_SNAPSHOT_EVENT: &str = "([^"]+)"/,
    ],
  },
  {
    label: 'runtime notification event',
    expected: 'runtime://notification',
    ts: [runtimeCoreSchemaPath, /export const RUNTIME_NOTIFICATION_EVENT = '([^']+)'/],
    rust: [
      path.join('apps', 'desktop', 'src-tauri', 'src', 'runtime', 'events.rs'),
      /pub const RUNTIME_NOTIFICATION_EVENT: &str = "([^"]+)"/,
    ],
  },
  {
    label: 'audio runtime snapshot event',
    expected: 'audio://snapshot',
    ts: [path.join('apps', 'desktop', 'src', 'schema', 'audio-runtime.ts'), /export const AUDIO_RUNTIME_SNAPSHOT_EVENT = '([^']+)'/],
    rust: [
      path.join('apps', 'desktop', 'src-tauri', 'src', 'audio', 'events.rs'),
      /pub const AUDIO_RUNTIME_SNAPSHOT_EVENT: &str = "([^"]+)"/,
    ],
  },
];
for (const pin of eventNamePins) {
  const tsValue = extractLiteral(pin.ts[0], pin.ts[1], `${pin.label} (TypeScript)`);
  const rustValue = extractLiteral(pin.rust[0], pin.rust[1], `${pin.label} (Rust)`);
  if (tsValue === null || rustValue === null) {
    continue;
  }
  if (tsValue !== rustValue) {
    fail(`${pin.label} literals disagree: TS='${tsValue}' (${pin.ts[0]}) vs Rust='${rustValue}' (${pin.rust[0]})`);
  } else if (tsValue !== pin.expected) {
    fail(`${pin.label} drifted from pinned '${pin.expected}': both sides now use '${tsValue}'`);
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
