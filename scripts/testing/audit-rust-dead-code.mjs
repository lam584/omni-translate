import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const roots = ['apps/desktop/src-tauri/src', 'apps/bridge-service-native/src'];

async function rustFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? rustFiles(target) : entry.name.endsWith('.rs') ? [target] : [];
  }))).flat();
}

const violations = [];
for (const root of roots) {
  for (const file of await rustFiles(root)) {
    const source = await readFile(file, 'utf8');
    source.split(/\r?\n/u).forEach((line, index) => {
      if (line.includes('#![allow(dead_code')) {
        violations.push(`${file}:${index + 1}: module-level dead_code exemption is forbidden`);
      } else if (line.includes('allow(dead_code') && !line.includes('reason = ')) {
        violations.push(`${file}:${index + 1}: dead_code exemption requires an explicit reason`);
      }
    });
  }
}

if (violations.length > 0) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Rust dead_code audit passed: every exemption is item-scoped and documented.');
}
