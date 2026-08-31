// Config-path guard (阶段6 方案B, 2026-07-27).
//
// Every JSON-pointer literal the Rust side reads must be one of:
//   1. a config-domain path that resolves inside defaults/app-config.default.json
//      (the persisted-config shape source of truth; the default-merge repository
//      tests guarantee real documents are a superset of it);
//   2. a wire-protocol / provider-response path, allowed only from the wire
//      parser files listed below;
//   3. an explicitly documented entry in KNOWN_DEAD_READS or LEGACY_COMPAT_READS.
// Anything else fails: that is the guard against typo'd paths, paths removed
// from the TS schema while Rust still reads them, and copy-paste drift.
//
// Limitations (accepted in the phase-6 memo): dynamically built pointers
// (`format!`) and index semantics beyond what the default document contains
// are not checked. Test code (below the first `#[cfg(test)]` line, same
// convention as audit-architecture-boundaries) is not scanned.
//
// `node scripts/testing/verify-config-paths.mjs` runs the guard standalone;
// `--report-defaults` additionally writes the inline-default inventory to
// artifacts/config-default-inventory.md (paths whose call sites disagree on
// their unwrap_or default are the headline table).

import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const rustRoot = path.join('apps', 'desktop', 'src-tauri', 'src');
const defaultConfigPath = path.join('apps', 'desktop', 'src-tauri', 'defaults', 'app-config.default.json');

// Files whose job is parsing provider/bridge wire payloads; only they may read
// wire-protocol pointers. Path fragments are matched against the repo-relative
// file path with forward slashes.
const WIRE_PARSER_FILES = [
  'src-tauri/src/audio/openai_realtime.rs',
  'src-tauri/src/audio/gemini_live.rs',
  // Shared realtime event envelope parser used by production, benchmarks,
  // and provider smoke paths.
  'src-tauri/src/audio/realtime_ws.rs',
  'src-tauri/src/audio/omni/',
  'src-tauri/src/provider/gateway_parts/',
  'src-tauri/src/benchmark/',
  // Release-evidence preflight grants/reservations are signed external
  // authority documents, not persisted app config.  This module parses their
  // wire shape before any Provider connection.
  'src-tauri/src/release_evidence_diagnostic/provider_preflight_authority.rs',
];

// Wire-payload path prefixes (OpenAI realtime `session`/`response`, Gemini
// `setup`/`serverContent`/`goAway`, DashScope `output`/`usage`, generic stream
// scaffolding). A read is wire-exempt only when BOTH the prefix and the file
// match; a config-domain path never collides because config classification
// (resolution in the default document) runs first.
const WIRE_PREFIXES = [
  '/authorization', '/choices', '/code', '/data', '/delta', '/detail', '/error', '/event', '/goAway',
  '/id', '/input_audio_format', '/input_audio_transcription',
  '/input_tokens', '/message', '/models', '/output', '/output_tokens',
  '/model', '/modalities', '/response', '/sample_rate', '/serverContent',
  '/session', '/setup', '/text', '/transcript', '/translation', '/type',
  '/usage', '/artifactKind',
];

// Reads of config sections the schema does not have: they always fall through
// to their inline default. Recorded, not exempted-away: each entry warns on
// every run until the domain fix lands, and a stale entry (path no longer
// read) fails so the list cannot rot. Do not add entries to make the guard
// pass for new code — fix the path instead. Empty is the steady state (the
// original four entries were fixed on 2026-07-27: engine now reads the
// direction's voice model, diagnostics reads the provider probe store).
const KNOWN_DEAD_READS = [];

// Pointers that intentionally target keys only present in pre-schema documents
// (kept alive by the repository's unknown-field passthrough). Every listed
// file must still touch the pointer or the entry fails as stale.
const LEGACY_COMPAT_POINTERS = [
  {
    pointer: '/vad/bypass',
    files: [
      'src-tauri/src/audio/events/route_config.rs',
      'src-tauri/src/watch_mode_diagnostic/config.rs',
    ],
    reason: 'legacy VAD toggle: the watch-mode CLI writes it, resolve_legacy_vad_bypass_for_route reads it for configs written before VAD moved under devices.*.',
  },
];

function collectRustFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectRustFiles(entryPath));
    else if (entry.name.endsWith('.rs')) out.push(entryPath);
  }
  return out;
}

/**
 * Blanks `#[cfg(test)]` items (both `mod x;` declarations and `mod x { … }`
 * blocks) while preserving line numbering, so pointer literals inside test
 * fixtures are not scanned but reported line numbers stay accurate.
 */
function productionSlice(text) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() !== '#[cfg(test)]') continue;
    lines[i] = '';
    let j = i + 1;
    let depth = 0;
    let sawBrace = false;
    while (j < lines.length) {
      const line = lines[j];
      depth += (line.match(/{/g) ?? []).length - (line.match(/}/g) ?? []).length;
      if (line.includes('{')) sawBrace = true;
      const isDeclEnd = !sawBrace && line.trimEnd().endsWith(';');
      lines[j] = '';
      j += 1;
      if (isDeclEnd || (sawBrace && depth <= 0)) break;
    }
    i = j - 1;
  }
  return lines.join('\n');
}

/** All pointer-literal reads plus set_json_pointer_* write paths. */
function collectPointerSites() {
  const sites = [];
  for (const file of collectRustFiles(path.join(rootDir, rustRoot))) {
    const rel = path.relative(rootDir, file).split(path.sep).join('/');
    const text = productionSlice(fs.readFileSync(file, 'utf8'));
    for (const match of text.matchAll(/\.pointer\(\s*"(\/[^"]*)"/g)) {
      const line = text.slice(0, match.index).split('\n').length;
      sites.push({ pointer: match[1], file: rel, line, kind: 'read', tail: text.slice(match.index, match.index + 260) });
    }
    for (const match of text.matchAll(/set_json_pointer_\w+\s*\(\s*(?:&mut\s+)?\w+\s*,\s*&\[([^\]]*)\]/g)) {
      const segments = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      if (!segments.length) continue;
      const line = text.slice(0, match.index).split('\n').length;
      sites.push({ pointer: '/' + segments.join('/'), file: rel, line, kind: 'write', tail: '' });
    }
  }
  return sites;
}

function resolveInDefaultConfig(pointer, defaultConfig) {
  let node = defaultConfig;
  for (const rawSegment of pointer.split('/').slice(1)) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(node)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index >= node.length) return { found: false };
      node = node[index];
    } else if (node !== null && typeof node === 'object' && segment in node) {
      node = node[segment];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: node };
}

// serde_json accessor family a read may legally apply, keyed by the JSON type
// of the default-document value at that path. Catches `as_str` on a bool
// field and friends — the residual type-safety a Rust config struct would
// have bought (方案A devices 子域 compensating control, 2026-07-27 决策).
const ACCESSORS_BY_TYPE = {
  string: ['as_str'],
  boolean: ['as_bool'],
  number: ['as_u64', 'as_i64', 'as_f64'],
};

function checkAccessorType(site, value, failures) {
  if (site.kind !== 'read') return;
  const accessorMatch = /\.and_then\(Value::as_(\w+)\)/.exec(site.tail);
  if (!accessorMatch) return;
  const accessor = 'as_' + accessorMatch[1];
  const jsonType = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  const allowed = ACCESSORS_BY_TYPE[jsonType];
  if (allowed && !allowed.includes(accessor)) {
    failures.push(
      `type-mismatched config read: ${site.pointer} is ${jsonType} in the default document`
      + ` but ${site.file}:${site.line} reads it with Value::${accessor} (always None at runtime)`,
    );
  }
}

function extractInlineDefault(tail) {
  const m = /\.unwrap_or(?:_else|_default)?\(\s*(?:\|\|\s*)?("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false|String::new\(\)|Vec::new\(\)|\))?/.exec(tail);
  if (!m) return null;
  // A `.map(...)` between the pointer read and the unwrap transforms the value
  // (usually a presence check), so the unwrap argument is not this path's
  // default — report it as opaque instead of a fake conflict.
  const mapIndex = tail.indexOf('.map(');
  if (mapIndex !== -1 && mapIndex < m.index) return null;
  if (m[0].includes('unwrap_or_default')) return 'Default::default()';
  return m[1] && m[1] !== ')' ? m[1] : null;
}

export function verifyConfigPaths() {
  const failures = [];
  const warnings = [];
  const defaultConfig = JSON.parse(fs.readFileSync(path.join(rootDir, defaultConfigPath), 'utf8'));
  const sites = collectPointerSites();
  const usedDead = new Set();
  const usedLegacy = new Set();
  const configSites = [];

  for (const site of sites) {
    const resolved = resolveInDefaultConfig(site.pointer, defaultConfig);
    if (resolved.found) {
      configSites.push(site);
      checkAccessorType(site, resolved.value, failures);
      continue;
    }
    const dead = KNOWN_DEAD_READS.find((e) => e.pointer === site.pointer && site.file.includes(e.file));
    if (dead) {
      usedDead.add(dead.pointer + '@' + dead.file);
      warnings.push(`known dead config read (${dead.reason}): ${site.pointer} at ${site.file}:${site.line}`);
      continue;
    }
    const legacy = LEGACY_COMPAT_POINTERS.find(
      (e) => e.pointer === site.pointer && e.files.some((f) => site.file.includes(f)),
    );
    if (legacy) {
      usedLegacy.add(legacy.pointer + '@' + legacy.files.find((f) => site.file.includes(f)));
      continue;
    }
    const wirePrefix = WIRE_PREFIXES.find((p) => site.pointer === p || site.pointer.startsWith(p + '/'));
    if (wirePrefix) {
      if (WIRE_PARSER_FILES.some((f) => site.file.includes(f))) continue;
      failures.push(
        `wire-protocol pointer ${site.pointer} read outside the wire parser files: ${site.file}:${site.line}`
        + ' (config code must not parse provider payloads; if this file became a parser, add it to WIRE_PARSER_FILES with justification)',
      );
      continue;
    }
    failures.push(
      `unknown config pointer ${site.pointer} at ${site.file}:${site.line}: not resolvable in ${defaultConfigPath}`
      + ' and not a documented wire/legacy/dead read. Fix the path, or add the field to the default config document.',
    );
  }

  for (const entry of KNOWN_DEAD_READS) {
    if (!usedDead.has(entry.pointer + '@' + entry.file)) {
      failures.push(`stale KNOWN_DEAD_READS entry (read no longer exists — delete it): ${entry.pointer} @ ${entry.file}`);
    }
  }
  for (const entry of LEGACY_COMPAT_POINTERS) {
    for (const file of entry.files) {
      if (!usedLegacy.has(entry.pointer + '@' + file)) {
        failures.push(`stale LEGACY_COMPAT_POINTERS file (pointer no longer touched there — delete it): ${entry.pointer} @ ${file}`);
      }
    }
  }

  return { failures, warnings, sites, configSites };
}

export function buildDefaultsInventory(configSites) {
  const byPointer = new Map();
  for (const site of configSites) {
    if (site.kind !== 'read') continue;
    const token = extractInlineDefault(site.tail) ?? '(none/complex)';
    if (!byPointer.has(site.pointer)) byPointer.set(site.pointer, new Map());
    const perDefault = byPointer.get(site.pointer);
    if (!perDefault.has(token)) perDefault.set(token, []);
    perDefault.get(token).push(`${site.file}:${site.line}`);
  }
  return byPointer;
}

function writeDefaultsReport(byPointer) {
  const conflicting = [...byPointer.entries()]
    .filter(([, defaults]) => new Set([...defaults.keys()].filter((t) => t !== '(none/complex)')).size > 1)
    .sort(([a], [b]) => a.localeCompare(b));
  const lines = [
    '# 配置内联默认值清点（阶段6 方案B 前置，生成于 verify-config-paths.mjs --report-defaults）',
    '',
    '方法：对每个可在 app-config.default.json 中解析的 `.pointer("…")` 读取点，向后 260 字符内提取首个',
    '`unwrap_or*(…)` 字面量（正则启发式；取不到的记 `(none/complex)`，不计入冲突判定）。',
    '',
    `## 同一路径多默认值冲突（${conflicting.length} 条）——每条里至少有一处调用点拿错缺省行为`,
    '',
  ];
  for (const [pointer, defaults] of conflicting) {
    lines.push(`### \`${pointer}\``);
    for (const [token, sites] of [...defaults.entries()].sort()) {
      lines.push(`- 默认 ${token}`);
      for (const site of sites) lines.push(`  - ${site}`);
    }
    lines.push('');
  }
  lines.push('## 全量清单（路径 → 默认值 → 调用点数）', '');
  for (const [pointer, defaults] of [...byPointer.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const parts = [...defaults.entries()].map(([token, sites]) => `${token} ×${sites.length}`);
    lines.push(`- \`${pointer}\`: ${parts.join(' | ')}`);
  }
  lines.push('');
  const reportPath = path.join(rootDir, 'artifacts', 'config-default-inventory.md');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  return { reportPath, conflicting: conflicting.length };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (isMain) {
  const { failures, warnings, sites, configSites } = verifyConfigPaths();
  for (const warning of warnings) console.warn(`verify-config-paths: ${warning}`);
  if (process.argv.includes('--report-defaults')) {
    const { reportPath, conflicting } = writeDefaultsReport(buildDefaultsInventory(configSites));
    console.log(`Defaults inventory written: ${path.relative(rootDir, reportPath)} (${conflicting} conflicting paths).`);
  }
  if (failures.length) {
    console.error('Config path verification failed:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log(
    `Config path verification passed: ${sites.length} pointer sites, ${configSites.length} config-domain`
    + ` (${warnings.length} documented dead reads).`,
  );
}
