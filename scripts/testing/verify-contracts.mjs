import fs from 'node:fs';
import path from 'node:path';

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
const driverBridgeSchemaPath = path.join('apps', 'desktop', 'src', 'schema', 'driver-bridge-contract.ts');

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
// Field-level contract key validation.
// Rust key sets come from scripts/testing/contract-keys.fixture.json, generated
// by the contract_keys cargo test (apps/desktop/src-tauri/src/contract_keys_fixture.rs).
// TypeScript key sets are parsed from the schema files below. Both directions of
// drift fail: a key only on the Rust side or only on the TypeScript side.
const contractKeysFixtureRelativePath = path.join('scripts', 'testing', 'contract-keys.fixture.json');
const contractKeysRegenHint =
  "regenerate with OMNI_UPDATE_CONTRACT_KEYS=1 cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml contract_keys (PowerShell: $env:OMNI_UPDATE_CONTRACT_KEYS='1'; cargo test ...)";

function stripTsComments(source) {
  let out = '';
  let i = 0;
  let state = 'code';
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (state === 'code') {
      if (ch === '/' && next === '/') {
        state = 'line';
        i += 2;
        continue;
      }
      if (ch === '/' && next === '*') {
        state = 'block';
        i += 2;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        state = ch;
      }
      out += ch;
      i += 1;
      continue;
    }
    if (state === 'line') {
      if (ch === '\n') {
        state = 'code';
        out += ch;
      }
      i += 1;
      continue;
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') {
        state = 'code';
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    // inside a string literal
    if (ch === '\\') {
      out += ch + (next ?? '');
      i += 2;
      continue;
    }
    if (ch === state) {
      state = 'code';
    }
    out += ch;
    i += 1;
  }
  return out;
}

// Parses the top-level field names of `export type <name> = { ... }`.
// Limitations (reported, not silently ignored): only object literal type
// aliases are supported (union/alias/generic right-hand sides are rejected),
// members are expected to be `;`-separated, and members that do not look like
// `name?: ...` (e.g. index signatures or mapped types) are surfaced as skipped.
function parseTsObjectTypeFields(relativePath, typeName) {
  const text = stripTsComments(readText(relativePath));
  const anchor = new RegExp(`export type ${escapeRegExp(typeName)}\\s*=`);
  const anchorMatch = anchor.exec(text);
  if (!anchorMatch) {
    return { error: `export type ${typeName} not found` };
  }
  let i = anchorMatch.index + anchorMatch[0].length;
  while (i < text.length && /\s/.test(text[i])) {
    i += 1;
  }
  if (text[i] !== '{') {
    return { error: `export type ${typeName} is not an object literal type; field parsing unsupported` };
  }
  i += 1;
  let depth = 1;
  let member = '';
  const fields = [];
  const skipped = [];
  const flushMember = () => {
    const trimmed = member.trim();
    member = '';
    if (!trimmed) {
      return;
    }
    const fieldMatch = /^(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*\??\s*:/.exec(trimmed);
    if (fieldMatch) {
      fields.push(fieldMatch[1]);
    } else {
      skipped.push(trimmed.slice(0, 60));
    }
  };
  for (; i < text.length && depth > 0; i += 1) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      let literal = ch;
      i += 1;
      while (i < text.length && text[i] !== quote) {
        literal += text[i];
        if (text[i] === '\\' && i + 1 < text.length) {
          i += 1;
          literal += text[i];
        }
        i += 1;
      }
      literal += quote;
      if (depth === 1) {
        member += literal;
      }
      continue;
    }
    if (ch === '{') {
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        flushMember();
      }
      continue;
    }
    if (ch === ';' && depth === 1) {
      flushMember();
      continue;
    }
    if (depth === 1) {
      member += ch;
    }
  }
  if (depth !== 0) {
    return { error: `export type ${typeName} has unbalanced braces` };
  }
  return { fields: new Set(fields), skipped };
}

// Explicit exemptions for intentional one-sided fields. Every entry must name
// the struct, the exempted keys, and a reason. Do not add entries merely to
// make the check pass; an empty list is the expected steady state.
const contractFieldExemptions = {
  // Example:
  // StructName: { rustOnly: ['keyA'], tsOnly: ['keyB'], reason: 'frontend-only display field' },
};

const contractFieldChecks = [
  { struct: 'BridgeInitRequest', tsFile: driverBridgeSchemaPath, tsType: 'BridgeInitRequest' },
  { struct: 'BridgeInitResponse', tsFile: driverBridgeSchemaPath, tsType: 'BridgeInitResponse' },
  { struct: 'BridgeMixControl', tsFile: driverBridgeSchemaPath, tsType: 'BridgeMixControl' },
  { struct: 'BridgeRuntimeSnapshot', tsFile: runtimeCoreSchemaPath, tsType: 'BridgeRuntimeSnapshot' },
  { struct: 'BridgeStateResponse', tsFile: driverBridgeSchemaPath, tsType: 'BridgeStateSnapshot' },
  { struct: 'BridgeTranslationFrameAck', tsFile: driverBridgeSchemaPath, tsType: 'BridgeTranslationFrameAck' },
  { struct: 'BridgeTranslationFrameHeader', tsFile: driverBridgeSchemaPath, tsType: 'BridgeInlinePcmFrameHeader' },
  { struct: 'DiagnosticLogCategoryRuntime', tsFile: runtimeCoreSchemaPath, tsType: 'DiagnosticLogCategoryRuntime' },
  { struct: 'DiagnosticLogEntryRuntime', tsFile: runtimeCoreSchemaPath, tsType: 'DiagnosticLogEntryRuntime' },
  { struct: 'DiagnosticSupportSignalRuntime', tsFile: runtimeCoreSchemaPath, tsType: 'DiagnosticSupportSignalRuntime' },
  { struct: 'DiagnosticsRuntimeSnapshot', tsFile: runtimeCoreSchemaPath, tsType: 'DiagnosticsRuntimeSnapshot' },
  { struct: 'DriverBridgeErrorEvent', tsFile: driverBridgeSchemaPath, tsType: 'DriverBridgeErrorEvent' },
  { struct: 'DriverOperationResult', tsFile: runtimeCoreSchemaPath, tsType: 'DriverOperationResult' },
  { struct: 'ModelTraceCallRuntime', tsFile: runtimeCoreSchemaPath, tsType: 'ModelTraceCallRuntime' },
  { struct: 'ModelTraceSummaryRuntime', tsFile: runtimeCoreSchemaPath, tsType: 'ModelTraceSummaryRuntime' },
  { struct: 'RuntimeNotification', tsFile: runtimeCoreSchemaPath, tsType: 'RuntimeNotification' },
  { struct: 'RuntimeSnapshot', tsFile: runtimeCoreSchemaPath, tsType: 'RuntimeSnapshot' },
  { struct: 'RuntimeWindowSnapshot', tsFile: runtimeCoreSchemaPath, tsType: 'RuntimeWindowSnapshot' },
  { struct: 'StorageRuntimeSnapshot', tsFile: runtimeCoreSchemaPath, tsType: 'StorageRuntimeSnapshot' },
];

let checkedContractStructCount = 0;
if (!fs.existsSync(fullPath(contractKeysFixtureRelativePath))) {
  fail(`contract key fixture is missing: ${contractKeysFixtureRelativePath} (${contractKeysRegenHint})`);
} else {
  const contractKeysFixture = readJson(contractKeysFixtureRelativePath);
  const fixtureStructs = contractKeysFixture.structs ?? {};
  for (const check of contractFieldChecks) {
    const rustKeys = fixtureStructs[check.struct];
    if (!Array.isArray(rustKeys)) {
      fail(`contract key fixture has no entry for ${check.struct} (${contractKeysRegenHint})`);
      continue;
    }
    const parsed = parseTsObjectTypeFields(check.tsFile, check.tsType);
    if (parsed.error) {
      fail(`cannot parse TypeScript type ${check.tsType} in ${check.tsFile}: ${parsed.error}`);
      continue;
    }
    if (parsed.skipped.length) {
      console.warn(
        `verify-contracts: skipped unparsable member(s) of ${check.tsType} in ${check.tsFile}: ${parsed.skipped.join(' | ')}`,
      );
    }
    const exemption = contractFieldExemptions[check.struct] ?? {};
    const rustOnly = rustKeys.filter(
      (key) => !parsed.fields.has(key) && !(exemption.rustOnly ?? []).includes(key),
    );
    const tsOnly = [...parsed.fields].filter(
      (key) => !rustKeys.includes(key) && !(exemption.tsOnly ?? []).includes(key),
    );
    if (rustOnly.length) {
      fail(
        `contract field drift for ${check.struct}: Rust emits keys missing from TS type ${check.tsType} in ${check.tsFile}: ${rustOnly.join(', ')}`,
      );
    }
    if (tsOnly.length) {
      fail(
        `contract field drift for ${check.struct}: TS type ${check.tsType} in ${check.tsFile} declares keys the Rust side does not emit: ${tsOnly.join(', ')} (if the Rust side changed, ${contractKeysRegenHint})`,
      );
    }
    checkedContractStructCount += 1;
  }
  for (const structName of Object.keys(fixtureStructs)) {
    if (!contractFieldChecks.some((check) => check.struct === structName)) {
      fail(`contract key fixture struct ${structName} has no TypeScript mapping in verify-contracts.mjs`);
    }
  }
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
  `Contract verification passed for protocol ${protocolVersion} (driver ${expectedDriverVersion}, bridge ${expectedBridgeVersion}, ${checkedContractStructCount} contract struct key sets).`,
);
