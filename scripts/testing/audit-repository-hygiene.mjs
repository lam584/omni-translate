import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

import {
  containsRetiredWorkspacePath,
  loadAuthorizedWatchAudioFixtures,
  sha256File,
  trackedFileSizeViolation,
} from './repository-hygiene-policy.mjs';

const trackedFiles = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
  .map((file) => file.replace(/\\/g, '/'));

const untrackedEntries = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--directory', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
  .map((entry) => entry.replace(/\\/g, '/'));

const untrackedGeneratedPattern = /(^|\/)\.(jscpd-[^/]+|codex|claude|codewhale|qoder|tmp)(\/|$)/i;

const allowedLogFixtures = /^scripts\/testing\/fixtures\/watch-mode-live\/[^/]+\/[^/]+\.log$/i;
const forbiddenPaths = [
  { pattern: /(^|\/)(artifacts|node_modules|target|dist|coverage)(\/|$)/i, reason: 'generated directory' },
  { pattern: /(^|\/)\.(claude|codewhale|qoder|idea|vscode)(\/|$)/i, reason: 'local IDE or AI-tool configuration' },
  { pattern: /drivers\/windows-virtual-mic\/sysvad\/.*\/x64\/(Debug|Release)(\/|$)/i, reason: 'driver build output' },
  { pattern: /(^|\/)Test\.mp3$/i, reason: 'retired third-party test media' },
  { pattern: /\.(tmp|temp|bak|old|orig|swp|swo|pid|jsonl)$/i, reason: 'temporary file' },
  { pattern: /\.(pfx|pem|key|cer|cat|exe|dll|sys|obj|lib|pdb|ilk|exp)$/i, reason: 'secret or compiled artifact' },
];

const authorizedWatchAudio = loadAuthorizedWatchAudioFixtures();

const violations = [];
for (const entry of untrackedEntries) {
  if (untrackedGeneratedPattern.test(entry)) {
    violations.push(`${entry}: untracked generated or agent-local artifact missing from .gitignore`);
  }
}
for (const file of trackedFiles) {
  if (!fs.existsSync(file)) continue;
  for (const rule of forbiddenPaths) {
    if (rule.pattern.test(file)) violations.push(`${file}: ${rule.reason}`);
  }
  if (/\.log$/i.test(file) && !allowedLogFixtures.test(file)) {
    violations.push(`${file}: log file outside the test-fixture allowlist`);
  }

  const stat = fs.statSync(file);
  const sizeViolation = trackedFileSizeViolation(file, stat.size, authorizedWatchAudio);
  if (sizeViolation) {
    violations.push(sizeViolation);
  } else if (authorizedWatchAudio.has(file)) {
    const expectedSha256 = authorizedWatchAudio.get(file);
    const actualSha256 = sha256File(file);
    if (actualSha256 !== expectedSha256) {
      violations.push(`${file}: authorized Watch Mode audio fixture SHA256 does not match its manifest`);
    }
  }
  if (stat.size > 2 * 1024 * 1024 || /\.(wav|png|ico|mp3)$/i.test(file)) continue;

  const content = fs.readFileSync(file, 'utf8');
  const isVendoredProviderDocumentation = file.startsWith('docs/vendor/aliyun/');
  if (!isVendoredProviderDocumentation && (/[A-Za-z]:\\Users\\[^\\\r\n]+/i.test(content) || /\/home\/[A-Za-z0-9._-]+\//.test(content))) {
    violations.push(`${file}: contains an absolute user-home path`);
  }
  if (containsRetiredWorkspacePath(content)) {
    violations.push(`${file}: contains the retired developer workspace path`);
  }
  if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/.test(content)) {
    violations.push(`${file}: contains a private-key header`);
  }
}

if (violations.length > 0) {
  console.error('Repository hygiene audit failed:');
  for (const violation of [...new Set(violations)].sort()) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(`Repository hygiene audit passed (${trackedFiles.length} tracked files checked).`);
