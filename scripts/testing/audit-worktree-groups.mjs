import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const GROUPS = [
  {
    id: 'A',
    name: 'Watch Mode live / driver / bridge / diagnostics / report',
    patterns: [
      /^scripts\/testing\/(?:run-watch-mode-live|watch-mode-report|verify-watch-mode-evidence|audit-worktree-groups)/,
      /^scripts\/installer\//,
      /^scripts\/diagnostics\//,
      /^drivers\/windows-virtual-mic\//,
      /^apps\/bridge-service\//,
      /^apps\/bridge-service-native\//,
      /^apps\/desktop\/src-tauri\/src\/bridge\//,
      /^apps\/desktop\/src-tauri\/src\/diagnostics\//,
      /^apps\/desktop\/src-tauri\/src\/audio\//,
      /^report\.(?:json|md)$/,
    ],
    verification: [
      'npm run check:bridge-service-native',
      'npm run test:watch-mode-report',
      'npm run test:watch-mode-evidence',
    ],
  },
  {
    id: 'B',
    name: 'Frontend pages / runtime / provider capability / UI',
    patterns: [
      /^apps\/desktop\/src\/(?:App|main|overlay)\./,
      /^apps\/desktop\/src\/router\.test\.ts$/,
      /^apps\/desktop\/src\/pages\//,
      /^apps\/desktop\/src\/components\//,
      /^apps\/desktop\/src\/runtime\//,
      /^apps\/desktop\/src\/schema\//,
      /^apps\/desktop\/src\/utils\//,
      /^apps\/desktop\/src\/i18n\//,
      /^apps\/desktop\/(?:eslint\.config\.js|vitest\.config\.ts)$/,
      /^apps\/desktop\/src-tauri\/src\/provider\//,
    ],
    verification: [
      'npm run check:desktop',
      'npm run verify:desktop',
      'npm run check:desktop-shell',
    ],
  },
  {
    id: 'C',
    name: 'Rust audio / provider / storage refactor modules',
    patterns: [
      /^apps\/desktop\/src-tauri\/src\/storage\//,
      /^apps\/desktop\/src-tauri\/src\/provider\/gateway_parts\//,
      /^apps\/desktop\/src-tauri\/src\/common\.rs$/,
      /^apps\/desktop\/src-tauri\/src\/main\.rs$/,
      /^apps\/desktop\/src-tauri\/defaults\//,
      /^apps\/desktop\/src-tauri\/src\/benchmark\//,
      /^apps\/desktop\/src-tauri\/Cargo\.(?:toml|lock)$/,
    ],
    verification: [
      'npm run check:desktop-shell',
      'npm run test:desktop-shell',
    ],
  },
  {
    id: 'D',
    name: 'Scripts cleanup / README / docs / styles',
    patterns: [
      /^README(?:\.en)?\.md$/,
      /^\.github\//,
      /^\.gitignore$/,
      /^REFACTOR-TODO\.md$/,
      /^refactor-analysis\.md$/,
      /^package(?:-lock)?\.json$/,
      /^docs\//,
      /^i18n\//,
      /^scripts\//,
      /^apps\/desktop\/src\/styles(?:\.css|\/)/,
      /^qodana\.yaml$/,
      /^convert-selectors\.js$/,
    ],
    verification: [
      'npm run test:watch-mode-report',
      'npm run quality:gate',
    ],
  },
];

function normalizeStatusPath(rawPath) {
  return rawPath.replace(/\\/g, '/').replace(/^"|"$/g, '');
}

function parsePorcelain(output) {
  if (!output.trim()) return [];
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const status = line.slice(0, 2);
      const rawPath = line.slice(3);
      const renameParts = rawPath.split(' -> ');
      return {
        status,
        path: normalizeStatusPath(renameParts.at(-1)),
      };
    });
}

export function groupChanges(changes) {
  const grouped = Object.fromEntries(GROUPS.map((group) => [group.id, { ...group, files: [] }]));
  const unclassified = [];
  for (const change of changes) {
    const group = GROUPS.find((item) => item.patterns.some((pattern) => pattern.test(change.path)));
    if (group) {
      grouped[group.id].files.push(change);
    } else {
      unclassified.push(change);
    }
  }
  return { groups: Object.values(grouped), unclassified };
}

function readGitStatus() {
  const output = execFileSync('git', ['-c', 'core.quotepath=false', 'status', '--porcelain'], { encoding: 'utf8' });
  return parsePorcelain(output);
}

export function renderAudit(audit) {
  const lines = ['# Worktree Change Group Audit', ''];
  for (const group of audit.groups) {
    lines.push(`## Group ${group.id}: ${group.name}`);
    lines.push(`Files: ${group.files.length}`);
    for (const file of group.files) {
      lines.push(`- ${file.status.trim() || 'M'} ${file.path}`);
    }
    lines.push('Suggested verification:');
    for (const command of group.verification) {
      lines.push(`- ${command}`);
    }
    lines.push('');
  }
  lines.push('## Unclassified');
  lines.push(`Files: ${audit.unclassified.length}`);
  for (const file of audit.unclassified) {
    lines.push(`- ${file.status.trim() || 'M'} ${file.path}`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const audit = groupChanges(readGitStatus());
  process.stdout.write(renderAudit(audit));
  process.exitCode = audit.unclassified.length > 0 ? 1 : 0;
}
