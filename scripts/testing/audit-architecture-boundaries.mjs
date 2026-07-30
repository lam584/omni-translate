import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import ts from 'typescript';

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

function rustProductionText(path) {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const kept = [];
  let skipTests = false;
  let braceDepth = 0;
  for (const line of lines) {
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
    kept.push(line);
  }
  return kept.join('\n');
}

function typescriptSyntaxFacts(path, text) {
  const source = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const imports = [];
  let invokeCalls = 0;
  let tauriProbeCalls = 0;
  let modelKeywordChecks = 0;
  const modelKeywords = /^(?:omni|livetranslate|realtime|live|gemini|whisper|translat(?:e|ion)|transcrib(?:e|tion)|asr)$/i;
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      imports.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteralLike(node.arguments[0])) {
        imports.push(node.arguments[0].text);
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require' && ts.isStringLiteralLike(node.arguments[0])) {
        imports.push(node.arguments[0].text);
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === 'invoke') invokeCalls += 1;
      if (ts.isIdentifier(node.expression) && node.expression.text === 'isTauriRuntime') tauriProbeCalls += 1;
      if (
        ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'includes'
        && ts.isStringLiteralLike(node.arguments[0])
        && modelKeywords.test(node.arguments[0].text)
        && /(?:model|haystack|normalized|lower|value)/i.test(node.expression.expression.getText(source))
      ) {
        modelKeywordChecks += 1;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { imports, invokeCalls, tauriProbeCalls, modelKeywordChecks };
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
    const rel = relative(root, path).replace(/\\/g, '/');
    const modelInferenceAllowlist = new Set([
      'apps/desktop/src-tauri/src/audio/events/route_config.rs',
      'apps/desktop/src-tauri/src/provider/gateway_parts/models.rs',
    ]);
    if (!modelInferenceAllowlist.has(rel)) {
      const code = rustProductionText(path);
      const checks = code.match(/(?:model|lower|normalized|haystack)[A-Za-z0-9_().]*\.contains\(\s*"(?:omni|livetranslate|realtime|live|gemini|whisper|translate|translation|transcribe|transcription|asr)"/gi) ?? [];
      if (checks.length > 0) violations.push(`Realtime model-name inference outside resolver: ${rel}`);
    }
  }
}

const pageRoot = join(root, 'apps/desktop/src/pages');
for (const path of walk(pageRoot, (path) => path.endsWith('Page.tsx'))) {
  const lines = sourceLines(path);
  if (lines > 450) violations.push(`React page >450 lines: ${relative(root, path)} (${lines})`);
}

for (const path of walk(pageRoot, (path) => path.endsWith('Screen.tsx'))) {
  const lines = sourceLines(path);
  if (lines > 600) violations.push(`React screen >600 lines: ${relative(root, path)} (${lines})`);
}

for (const path of walk(pageRoot, (path) => path.endsWith('Workspace.tsx'))) {
  const lines = sourceLines(path);
  if (lines > 900) violations.push(`React workspace >900 lines: ${relative(root, path)} (${lines})`);
}

const frontendRoot = 'apps/desktop/src';
const frontend = walk(join(root, frontendRoot), (path) => /\.(ts|tsx)$/.test(path));
// Environment probing is confined to the composition roots (desktop-api.ts
// decides once, desktop-runtime.ts owns the late-heal); everything else must
// consume the installed desktop-api capabilities. Cap the total production
// call-site count so inline probing cannot creep back in.
const PROBE_CALL_SITE_CAP = 5;
let probeCallSites = 0;
for (const path of frontend) {
  const rel = relative(root, path).replace(/\\/g, '/');
  // Test files and ambient declarations are exempt from the import rules below.
  if (/\.(test|spec)\.[jt]sx?$/.test(rel) || rel.endsWith('.d.ts')) continue;
  const text = readFileSync(path, 'utf8');
  const syntax = typescriptSyntaxFacts(path, text);
  const inRuntime = rel.startsWith(`${frontendRoot}/runtime/`);
  // Test support code (the mocks themselves and shared test helpers) may
  // import mocks; production code may not.
  const inTestSupport =
    rel.startsWith(`${frontendRoot}/mocks/`) || rel.startsWith(`${frontendRoot}/test-utils/`);
  const modelInferenceAllowlist = new Set([
    `${frontendRoot}/utils/realtime-profile.ts`,
    `${frontendRoot}/utils/provider-model-capabilities.ts`,
  ]);
  if (!modelInferenceAllowlist.has(rel) && syntax.modelKeywordChecks > 0) {
    violations.push(`Realtime model-name inference outside resolver: ${rel}`);
  }

  if (!inTestSupport && rel !== `${frontendRoot}/runtime/tauri-runtime.ts`) {
    probeCallSites += syntax.tauriProbeCalls;
  }

  // Tauri APIs are only reachable through the runtime adapter layer.
  if (!inRuntime && syntax.imports.some((specifier) => specifier.startsWith('@tauri-apps/api'))) {
    violations.push(`Tauri import outside runtime: ${rel}`);
  }

  // Production code must not depend on test doubles in src/mocks; shared
  // preset/default data lives in src/defaults.
  if (!inTestSupport && syntax.imports.some((specifier) => /(?:^|\/)mocks\//.test(specifier))) {
    violations.push(`Mocks import in production code: ${rel}`);
  }

  // Reverse layering: the runtime layer must not reach up into UI layers.
  if (inRuntime && syntax.imports.some((specifier) => /^(?:\.\.\/)+(?:pages|components)\//.test(specifier))) {
    violations.push(`Runtime imports UI layer: ${rel}`);
  }

  // All Tauri command calls funnel through the single runtime API adapter.
  // The pattern also matches generic calls such as invoke<T>(...).
  if (rel === 'apps/desktop/src/runtime/desktop-api-v2.ts') continue;
  if (syntax.invokeCalls > 0) violations.push(`Direct invoke: ${rel}`);
}

if (probeCallSites > PROBE_CALL_SITE_CAP) {
  violations.push(`isTauriRuntime call sites in production: ${probeCallSites} (cap ${PROBE_CALL_SITE_CAP})`);
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
