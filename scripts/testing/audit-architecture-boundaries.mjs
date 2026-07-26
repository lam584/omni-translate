import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';

const root = process.cwd();
const strict = process.argv.includes('--strict');
const updateBaseline = process.argv.includes('--update-baseline');
const baselinePath = join(root, 'scripts/testing/architecture-baseline.json');
const violations = [];

// Stable baseline key: rule + normalized relative path, without line/length
// numbers or function names, so line drift inside an already-listed file does
// not surface as a new violation. Multiple findings that share a rule and file
// collapse into a single baseline entry.
function baselineKey(message) {
  const separator = message.indexOf(': ');
  const rule = message.slice(0, separator);
  let subject = message.slice(separator + 2);
  subject = subject.replace(/ \(\d+\)$/, '');
  subject = subject.replace(/::[A-Za-z0-9_]+$/, '');
  return `${rule}: ${subject.replace(/\\/g, '/')}`;
}

function readBaselineKeys() {
  let text;
  try {
    text = readFileSync(baselinePath, 'utf8');
  } catch {
    return new Set();
  }
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed.violations)) {
    throw new Error(`Baseline file ${relative(root, baselinePath)} must contain a "violations" array.`);
  }
  return new Set(parsed.violations);
}

function writeBaseline(keys) {
  const payload = {
    comment:
      'Known architecture boundary violations tolerated by the non-strict audit. '
      + 'Regenerate with: node scripts/testing/audit-architecture-boundaries.mjs --update-baseline',
    violations: [...keys].sort(),
  };
  writeFileSync(baselinePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function walk(directory, predicate) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return walk(path, predicate);
    return predicate(path) ? [path] : [];
  });
}

function productionLines(path) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  let count = 0;
  let skipTests = false;
  let braceDepth = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!skipTests && line.trim() === '#[cfg(test)]') {
      skipTests = true;
      continue;
    }
    if (skipTests) {
      braceDepth += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length;
      if (braceDepth <= 0 && line.includes('}')) {
        skipTests = false;
        braceDepth = 0;
      }
      continue;
    }
    count += 1;
  }
  return count;
}

function sourceLines(path) {
  return readFileSync(path, 'utf8').split(/\r?\n/).length;
}

function rustOwnerCandidates(path) {
  const directory = dirname(path);
  if (basename(path) === 'mod.rs') {
    const parent = dirname(directory);
    return [join(parent, 'mod.rs'), `${parent}.rs`];
  }
  return [join(directory, 'mod.rs'), `${directory}.rs`];
}

function rustSourceIsWired(path) {
  const normalized = relative(root, path).replace(/\\/g, '/');
  const file = basename(path);
  if (file === 'main.rs' || file === 'lib.rs' || file === 'build.rs' || normalized.includes('/bin/')) {
    return true;
  }

  const moduleName = file === 'mod.rs' ? basename(dirname(path)) : basename(path, extname(path));
  const crateEntrypoints = rustRoots.flatMap((directory) => [
    join(root, directory, 'main.rs'),
    join(root, directory, 'lib.rs'),
  ]);
  return [...rustOwnerCandidates(path), ...crateEntrypoints].some((owner) => {
    try {
      const ownerText = readFileSync(owner, 'utf8');
      const modulePattern = new RegExp(`(?:^|\\n)\\s*(?:pub(?:\\([^)]*\\))?\\s+)?mod\\s+${moduleName}\\s*;`);
      const includePattern = new RegExp(`include!\\(\\s*["'][^"']*${file.replace('.', '\\.')}["']\\s*\\)`);
      return modulePattern.test(ownerText) || includePattern.test(ownerText);
    } catch {
      return false;
    }
  });
}

function functionSpans(path) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const spans = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)/);
    if (!match) continue;
    let depth = 0;
    let opened = false;
    for (let end = index; end < lines.length; end += 1) {
      const line = lines[end];
      const opens = (line.match(/{/g) ?? []).length;
      const closes = (line.match(/}/g) ?? []).length;
      if (opens > 0) opened = true;
      depth += opens - closes;
      if (opened && depth <= 0) {
        spans.push({ name: match[1], lines: end - index + 1 });
        index = end;
        break;
      }
    }
  }
  return spans;
}

const rustRoots = [
  'apps/desktop/src-tauri/src',
  'apps/bridge-service-native/src',
  'crates/omni-bridge-protocol/src',
  'crates/omni-logging/src',
];
for (const directory of rustRoots) {
  for (const path of walk(join(root, directory), (path) => /\.(?:rs|inc)$/.test(path))) {
    const count = productionLines(path);
    if (count > 900) violations.push(`Rust module >900 lines: ${relative(root, path)} (${count})`);
    for (const span of functionSpans(path)) {
      if (span.lines > 300) {
        violations.push(`Rust function >300 lines: ${relative(root, path)}::${span.name} (${span.lines})`);
      }
    }
    if (path.endsWith('.rs') && !rustSourceIsWired(path)) {
      violations.push(`Unwired Rust source: ${relative(root, path)}`);
    }
  }
}

const pageRoot = join(root, 'apps/desktop/src/pages');
for (const path of walk(pageRoot, (path) => path.endsWith('Page.tsx'))) {
  const text = readFileSync(path, 'utf8');
  const lines = text.split(/\r?\n/).length;
  if (lines > 450) violations.push(`React page >450 lines: ${relative(root, path)} (${lines})`);
  if (/@tauri-apps\/api/.test(text)) violations.push(`Page Tauri import: ${relative(root, path)}`);
}

for (const path of walk(pageRoot, (path) => path.endsWith('Screen.tsx'))) {
  const lines = sourceLines(path);
  if (lines > 600) violations.push(`React screen >600 lines: ${relative(root, path)} (${lines})`);
  if (/@tauri-apps\/api/.test(readFileSync(path, 'utf8'))) {
    violations.push(`Screen Tauri import: ${relative(root, path)}`);
  }
}

for (const path of walk(pageRoot, (path) => path.endsWith('Workspace.tsx'))) {
  const text = readFileSync(path, 'utf8');
  const lines = sourceLines(path);
  if (lines > 900) violations.push(`React workspace >900 lines: ${relative(root, path)} (${lines})`);
  if (/@tauri-apps\/api/.test(text)) violations.push(`Workspace Tauri import: ${relative(root, path)}`);
}

const frontend = walk(join(root, 'apps/desktop/src'), (path) => /\.(ts|tsx)$/.test(path));
for (const path of frontend) {
  const rel = relative(root, path).replace(/\\/g, '/');
  if (rel === 'apps/desktop/src/runtime/desktop-api-v2.ts') continue;
  if (/\.(test|spec)\.[jt]sx?$/.test(rel)) continue;
  if (/(?<!\.)\binvoke\(/.test(readFileSync(path, 'utf8'))) violations.push(`Direct invoke: ${rel}`);
}

const gateway = readFileSync(join(root, 'apps/desktop/src-tauri/src/provider/gateway.rs'), 'utf8');
for (const name of ['execute_openai', 'execute_dashscope', 'execute_dashscope_websocket', 'execute_dashscope_realtime_websocket']) {
  if (gateway.includes(name)) violations.push(`Legacy gateway method: ${name}`);
}

if (violations.length === 0) {
  console.log('Architecture boundary audit passed.');
} else {
  console.log(`Architecture boundary audit found ${violations.length} violation(s):`);
  for (const violation of violations) console.log(`- ${violation}`);
}

if (updateBaseline) {
  const keys = new Set(violations.map(baselineKey));
  writeBaseline(keys);
  console.log(`Baseline updated: ${keys.size} entr${keys.size === 1 ? 'y' : 'ies'} written to ${relative(root, baselinePath)}.`);
} else if (strict) {
  // Strict mode ignores the baseline: every violation fails the audit.
  if (violations.length > 0) process.exitCode = 1;
} else {
  const baselineKeys = readBaselineKeys();
  const currentKeys = new Set(violations.map(baselineKey));
  const newViolations = violations.filter((violation) => !baselineKeys.has(baselineKey(violation)));
  const resolved = [...baselineKeys].filter((key) => !currentKeys.has(key)).sort();
  if (resolved.length > 0) {
    console.log(`Baseline entries resolved (${resolved.length}) - run --update-baseline to prune them:`);
    for (const key of resolved) console.log(`- ${key}`);
  }
  if (newViolations.length > 0) {
    console.log(`New violation(s) not covered by baseline (${newViolations.length}):`);
    for (const violation of newViolations) console.log(`- ${violation}`);
    process.exitCode = 1;
  } else {
    console.log(`0 new violations (${baselineKeys.size} baselined).`);
  }
}
