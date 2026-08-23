import assert from 'node:assert/strict';
import test from 'node:test';

import {
  auditRecords,
  classifyLicenseText,
  collectNpmLicenses,
  expressionIsAllowed,
} from './audit-dependency-licenses.mjs';

test('evaluates SPDX AND, OR, legacy slash, and exception expressions', () => {
  assert.equal(expressionIsAllowed('MIT OR GPL-3.0-only'), true);
  assert.equal(expressionIsAllowed('MIT AND Apache-2.0'), true);
  assert.equal(expressionIsAllowed('MIT/Apache-2.0'), true);
  assert.equal(expressionIsAllowed('Apache-2.0 WITH LLVM-exception'), true);
  assert.equal(expressionIsAllowed('MIT AND GPL-3.0-only'), false);
  assert.equal(expressionIsAllowed('AGPL-3.0-only'), false);
  assert.equal(expressionIsAllowed('unknown-homegrown-license'), false);
});

test('recognizes common license-file text without accepting copyleft text', () => {
  assert.equal(classifyLicenseText('Permission is hereby granted, free of charge, to any person'), 'MIT');
  assert.equal(classifyLicenseText('Apache License\nVersion 2.0, January 2004'), 'Apache-2.0');
  assert.equal(classifyLicenseText('GNU GENERAL PUBLIC LICENSE Version 3'), null);
});

test('collects external npm lock entries and reports invalid licenses', () => {
  const records = collectNpmLicenses({
    packages: {
      '': { name: 'workspace' },
      'node_modules/good': { version: '1.0.0', license: 'MIT' },
      'node_modules/bad': { version: '2.0.0', license: 'GPL-3.0-only' },
      'packages/app': { link: true },
    },
  });
  assert.equal(records.length, 2);
  assert.deepEqual(auditRecords(records), ['npm:bad@2.0.0 declares GPL-3.0-only']);
});
