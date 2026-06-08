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
  path.join('apps', 'bridge-service-native', 'src', 'lib.rs'),
  new RegExp(`BRIDGE_PROTOCOL_VERSION:\\s*&str\\s*=\\s*"${protocolVersion}"`),
  'native bridge Rust protocol',
);
assertTextMatch(
  path.join('apps', 'desktop', 'src', 'schema', 'driver-bridge-contract.ts'),
  new RegExp(`DriverBridgeProtocolVersion\\s*=\\s*'${protocolVersion}'`),
  'desktop TypeScript bridge contract',
);
assertTextMatch(
  path.join('apps', 'desktop', 'src', 'mocks', 'app-config.ts'),
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
  new RegExp(`protocol_version:\\s*"${protocolVersion}"\\.to_string\\(\\)`),
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

const governanceFiles = [
  'package.json',
  'package-lock.json',
  'README.md',
  'README.en.md',
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

console.log(`Contract verification passed for protocol ${protocolVersion}.`);
