import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ECHO_CANCEL_REQUIRED_LAYERS, REQUIRED_LAYERS, findWatchModeEvidence } from './verify-watch-mode-evidence.mjs';

function echoCancelLayers() {
  return Object.fromEntries(REQUIRED_LAYERS.map((layer) => [
    layer,
    ECHO_CANCEL_REQUIRED_LAYERS.includes(layer)
      ? { status: 'passed', reason: null }
      : { status: 'skipped', reason: 'echo-cancel variant does not require this evidence layer' },
  ]));
}

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'watch-mode-evidence-'));
}

function writeReport(root, directoryName, overrides = {}) {
  const directory = path.join(root, directoryName);
  fs.mkdirSync(directory, { recursive: true });
  const layers = Object.fromEntries(REQUIRED_LAYERS.map((layer) => [layer, { status: 'passed', reason: null }]));
  const report = {
    schemaVersion: 1,
    generatedAt: '2026-06-05T11:13:32.000Z',
    mode: 'live',
    translationRoute: 'secondary',
    verdict: 'passed',
    failureLayer: null,
    layers,
    ...overrides,
  };
  fs.writeFileSync(path.join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

test('fails when no live report exists', () => {
  const root = makeTempRoot();
  const result = findWatchModeEvidence({ root });

  assert.equal(result.ok, false);
  assert.match(result.reason, /no complete live watch-mode report/);
});

test('passes when latest complete live report is passed', () => {
  const root = makeTempRoot();
  writeReport(root, '20260605-191332');

  const result = findWatchModeEvidence({ root });

  assert.equal(result.ok, true);
  assert.equal(result.latest.directoryName, '20260605-191332');
  assert.equal(result.latest.report.translationRoute, 'secondary');
});

test('fails when latest complete live report failed', () => {
  const root = makeTempRoot();
  writeReport(root, '20260605-191332', { generatedAt: '2026-06-05T11:13:32.000Z' });
  writeReport(root, '20260605-201332', {
    generatedAt: '2026-06-05T12:13:32.000Z',
    verdict: 'failed',
    failureLayer: 'bridge',
    layers: Object.fromEntries(REQUIRED_LAYERS.map((layer) => [
      layer,
      { status: layer === 'bridge' ? 'failed' : 'passed', reason: layer === 'bridge' ? 'bridge stalled' : null },
    ])),
  });

  const result = findWatchModeEvidence({ root });

  assert.equal(result.ok, false);
  assert.equal(result.latest.directoryName, '20260605-201332');
  assert.equal(result.latest.report.failureLayer, 'bridge');
  assert.deepEqual(result.failedLayers, ['bridge']);
  assert.match(result.reason, /bridge stalled/);
  assert.equal(result.latestFailure.failureReason, 'bridge stalled');
});

test('failure summaries preserve report reason, failed steps, and key evidence', () => {
  const root = makeTempRoot();
  writeReport(root, '20260605-201332', {
    generatedAt: '2026-06-05T12:13:32.000Z',
    verdict: 'failed',
    failureLayer: 'provider',
    failureReason: 'HTTP 429 quota exceeded providerId=provider-dashscope modelId=qwen3.6-flash-2026-04-16',
    diagnostics: {
      failedSteps: [
        { name: 'wait for watch-mode app readiness', error: 'timed out waiting for app log pattern' },
      ],
      checkFailures: [
        { layer: 'provider', reason: 'HTTP 429 quota exceeded' },
      ],
      evidence: {
        appProviderErrors: [
          'provider.translate_text failed HTTP 429 quota exceeded providerId=provider-dashscope modelId=qwen3.6-flash-2026-04-16',
        ],
      },
    },
    layers: Object.fromEntries(REQUIRED_LAYERS.map((layer) => [
      layer,
      { status: layer === 'provider' ? 'failed' : 'passed', reason: layer === 'provider' ? 'HTTP 429 quota exceeded' : null },
    ])),
  });

  const result = findWatchModeEvidence({ root });

  assert.equal(result.ok, false);
  assert.match(result.reason, /HTTP 429 quota exceeded/);
  assert.equal(result.latestFailure.failureLayer, 'provider');
  assert.equal(result.latestFailure.failedSteps[0].name, 'wait for watch-mode app readiness');
  assert(result.latestFailure.keyEvidence.some((line) => /provider-dashscope/.test(line)));
});

test('reports incomplete and invalid latest reports with concrete paths', () => {
  const root = makeTempRoot();
  const incompleteDir = path.join(root, '20260605-201332');
  fs.mkdirSync(incompleteDir, { recursive: true });
  fs.writeFileSync(path.join(incompleteDir, 'report.json'), JSON.stringify({
    mode: 'live',
    generatedAt: '2026-06-05T12:13:32.000Z',
    verdict: 'failed',
    failureLayer: 'app',
    failureReason: 'runner crashed before snapshots completed',
    layers: {
      app: { status: 'failed', reason: 'runner crashed before snapshots completed' },
    },
  }));

  const incomplete = findWatchModeEvidence({ root });

  assert.equal(incomplete.ok, false);
  assert.match(incomplete.reason, /incomplete/);
  assert.match(incomplete.reason, /missingLayers=/);
  assert.match(incomplete.reason, /report\.json/);
  assert.equal(incomplete.invalidCandidates[0].incomplete, true);

  const invalidRoot = makeTempRoot();
  const invalidDir = path.join(invalidRoot, '20260605-201332');
  fs.mkdirSync(invalidDir, { recursive: true });
  fs.writeFileSync(path.join(invalidDir, 'report.json'), '{ invalid json');

  const invalid = findWatchModeEvidence({ root: invalidRoot });

  assert.equal(invalid.ok, false);
  assert.match(invalid.reason, /could not be parsed/);
  assert.match(invalid.reason, /report\.json/);
  assert(invalid.invalidCandidates[0].parseError);
});

test('does not fall back to stale complete reports when the latest report is incomplete or invalid', () => {
  const incompleteRoot = makeTempRoot();
  writeReport(incompleteRoot, '20260605-191332', {
    generatedAt: '2026-06-05T11:13:32.000Z',
  });
  const incompleteDir = path.join(incompleteRoot, '20260605-201332');
  fs.mkdirSync(incompleteDir, { recursive: true });
  fs.writeFileSync(path.join(incompleteDir, 'report.json'), JSON.stringify({
    mode: 'live',
    generatedAt: '2026-06-05T12:13:32.000Z',
    verdict: 'failed',
    failureLayer: 'app',
    failureReason: 'runner crashed before snapshots completed',
    layers: {
      app: { status: 'failed', reason: 'runner crashed before snapshots completed' },
    },
  }));

  const incomplete = findWatchModeEvidence({ root: incompleteRoot });

  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.latest, null);
  assert.match(incomplete.reason, /latest live report is incomplete/);
  assert.match(incomplete.latestFailure.failureReason, /missingLayers=/);
  assert.match(incomplete.latestFailure.keyEvidence.join('\n'), /missingLayers=/);

  const invalidRoot = makeTempRoot();
  writeReport(invalidRoot, '20260605-191332', {
    generatedAt: '2026-06-05T11:13:32.000Z',
  });
  const invalidDir = path.join(invalidRoot, '20260605-201332');
  fs.mkdirSync(invalidDir, { recursive: true });
  fs.writeFileSync(path.join(invalidDir, 'report.json'), '{ invalid json');

  const invalid = findWatchModeEvidence({ root: invalidRoot });

  assert.equal(invalid.ok, false);
  assert.equal(invalid.latest, null);
  assert.match(invalid.reason, /latest live report could not be parsed/);
  assert.match(invalid.latestFailure.keyEvidence.join('\n'), /parseError=/);
});

test('ignores smoke and cache directories', () => {
  const root = makeTempRoot();
  fs.mkdirSync(path.join(root, 'cache'), { recursive: true });
  writeReport(root, 'physical-output-smoke-20260605-191332');
  writeReport(root, 'reference-pcm-smoke-20260605-191332');

  const result = findWatchModeEvidence({ root });

  assert.equal(result.ok, false);
  assert.equal(result.candidates.length, 0);
});

test('does not use stale root-level report.json', () => {
  const root = makeTempRoot();
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify({
    mode: 'live',
    verdict: 'passed',
    layers: Object.fromEntries(REQUIRED_LAYERS.map((layer) => [layer, { status: 'passed' }])),
  }));

  const result = findWatchModeEvidence({ root });

  assert.equal(result.ok, false);
  assert.equal(result.latest, null);
});

test('strict mode fails when strict content is not applicable', () => {
  const root = makeTempRoot();
  writeReport(root, '20260605-191332', {
    layers: Object.fromEntries(REQUIRED_LAYERS.map((layer) => [
      layer,
      {
        status: 'passed',
        reason: null,
        data: layer === 'strictContent' ? { applicable: false, passed: true } : undefined,
      },
    ])),
  });

  const result = findWatchModeEvidence({ root, strict: true });

  assert.equal(result.ok, false);
  assert.match(result.reason, /strictContent gate was not applicable/);
  assert.deepEqual(result.failedLayers, ['strictContent']);
});

test('strict mode passes when strict content is applicable and passed', () => {
  const root = makeTempRoot();
  writeReport(root, '20260605-191332', {
    modelId: 'qwen3.5-omni-flash-realtime',
    layers: Object.fromEntries(REQUIRED_LAYERS.map((layer) => [
      layer,
      {
        status: 'passed',
        reason: null,
        data: layer === 'strictContent' ? { applicable: true, passed: true, coverage: 1 } : undefined,
      },
    ])),
  });

  const result = findWatchModeEvidence({ root, strict: true });

  assert.equal(result.ok, true);
  assert.equal(result.latest.modelId, 'qwen3.5-omni-flash-realtime');
});

test('strict model matrix requires every requested model', () => {
  const root = makeTempRoot();
  const strictLayers = Object.fromEntries(REQUIRED_LAYERS.map((layer) => [
    layer,
    {
      status: 'passed',
      reason: null,
      data: layer === 'strictContent' ? { applicable: true, passed: true, coverage: 1 } : undefined,
    },
  ]));
  writeReport(root, '20260605-191332-qwen3.5-omni-flash-realtime', {
    modelId: 'qwen3.5-omni-flash-realtime',
    layers: strictLayers,
  });

  const result = findWatchModeEvidence({
    root,
    strict: true,
    models: [
      'qwen3.5-omni-flash-realtime',
      'qwen3.5-livetranslate-flash-realtime',
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.modelResults.length, 2);
  assert.equal(result.modelResults[0].ok, true);
  assert.equal(result.modelResults[1].ok, false);
  assert.match(result.reason, /qwen3\.5-livetranslate-flash-realtime/);
});

test('strict model matrix passes when both requested models pass', () => {
  const root = makeTempRoot();
  const strictLayers = Object.fromEntries(REQUIRED_LAYERS.map((layer) => [
    layer,
    {
      status: 'passed',
      reason: null,
      data: layer === 'strictContent' ? { applicable: true, passed: true, coverage: 1 } : undefined,
    },
  ]));
  writeReport(root, '20260605-191332-qwen3.5-omni-flash-realtime', {
    generatedAt: '2026-06-05T11:13:32.000Z',
    modelId: 'qwen3.5-omni-flash-realtime',
    layers: strictLayers,
  });
  writeReport(root, '20260605-201332-qwen3.5-livetranslate-flash-realtime', {
    generatedAt: '2026-06-05T12:13:32.000Z',
    modelId: 'qwen3.5-livetranslate-flash-realtime',
    layers: strictLayers,
  });

  const result = findWatchModeEvidence({
    root,
    strict: true,
    models: [
      'qwen3.5-omni-flash-realtime',
      'qwen3.5-livetranslate-flash-realtime',
    ],
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.modelResults.map((item) => item.modelId), [
    'qwen3.5-omni-flash-realtime',
    'qwen3.5-livetranslate-flash-realtime',
  ]);
});

test('echo-cancel variant report passes with the reduced layer set when requested', () => {
  const root = makeTempRoot();
  writeReport(root, '20260605-191332-echo-cancel', {
    feedbackLoopPrevention: 'echo-cancel',
    layers: echoCancelLayers(),
  });

  const result = findWatchModeEvidence({ root, strict: true, feedbackModes: ['echo-cancel'] });

  assert.equal(result.ok, true);
  assert.equal(result.latest.feedbackMode, 'echo-cancel');
  assert.equal(result.latest.report.feedbackLoopPrevention, 'echo-cancel');
});

test('default gate ignores echo-cancel runs so virtual-driver evidence stays authoritative', () => {
  const root = makeTempRoot();
  writeReport(root, '20260605-201332-echo-cancel', {
    generatedAt: '2026-06-05T12:13:32.000Z',
    feedbackLoopPrevention: 'echo-cancel',
    layers: echoCancelLayers(),
  });
  writeReport(root, '20260605-191332', { generatedAt: '2026-06-05T11:13:32.000Z' });

  const result = findWatchModeEvidence({ root });

  assert.equal(result.ok, true);
  assert.equal(result.latest.directoryName, '20260605-191332');
  assert.equal(result.latest.feedbackMode, 'virtual-driver');
});

test('strict feedback-mode matrix requires every model and feedback mode combination', () => {
  const root = makeTempRoot();
  const strictLayers = Object.fromEntries(REQUIRED_LAYERS.map((layer) => [
    layer,
    {
      status: 'passed',
      reason: null,
      data: layer === 'strictContent' ? { applicable: true, passed: true, coverage: 1 } : undefined,
    },
  ]));
  writeReport(root, '20260605-191332-omni', {
    modelId: 'qwen3.5-omni-flash-realtime',
    layers: strictLayers,
  });
  writeReport(root, '20260605-201332-omni-echo-cancel', {
    generatedAt: '2026-06-05T12:13:32.000Z',
    modelId: 'qwen3.5-omni-flash-realtime',
    feedbackLoopPrevention: 'echo-cancel',
    layers: echoCancelLayers(),
  });

  const result = findWatchModeEvidence({
    root,
    strict: true,
    models: [
      'qwen3.5-omni-flash-realtime',
      'qwen3.5-livetranslate-flash-realtime',
    ],
    feedbackModes: ['virtual-driver', 'echo-cancel'],
  });

  assert.equal(result.ok, false);
  assert.equal(result.modelResults.length, 4);
  assert.equal(result.modelResults.filter((item) => item.ok).length, 2);
  assert.match(result.reason, /qwen3\.5-livetranslate-flash-realtime\[virtual-driver\]/);
  assert.match(result.reason, /qwen3\.5-livetranslate-flash-realtime\[echo-cancel\]/);
});
