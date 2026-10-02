import { assertStrictAecClosedLoopAuthority } from './verify-watch-mode-evidence.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createBalancedReleasePlan, liveCellsForReleasePlan, AEC_ITERATION_MANIFEST_KIND} from './watch-mode-balanced-release-plan.mjs';
import {requiredCellArtifactPaths} from './watch-mode-evidence-authority.mjs';
import {verifyStrictMatrixAuthority, verifyStrictAecIterationAuthority, writeStrictAecIterationVerificationReceipt,
  validateStrictMatrixVerificationReceipt, validateStrictAecIterationVerificationReceipt} from './verify-watch-mode-evidence.mjs';
import {writeAecIterationManifest, publishSuccessfulAecIteration} from './run-watch-mode-live-production-coordinator.mjs';
const selection = {modelId: 'qwen3.8-livetranslate-flash-realtime', endpointHost: 'scope.cn-beijing.maas.aliyuncs.com', region: 'cn-beijing', executionScope: 'aec-c03-iteration', aecWorker: 'vm131'};
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-aec-scope-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const plan = createBalancedReleasePlan(selection);
  const manifest = {schemaVersion: 1, artifactKind: AEC_ITERATION_MANIFEST_KIND, releaseSelection: selection,
    executionScope: selection.executionScope, aecWorker: selection.aecWorker, validationPlan: plan,
    authority: {executionScope: selection.executionScope}, releaseEligible: false, matrixVerification: 'not-run',
    cells: liveCellsForReleasePlan(plan), notRunCellIds: liveCellsForReleasePlan(createBalancedReleasePlan({modelId: selection.modelId, endpointHost: selection.endpointHost})).filter(c => c.feedbackLoopPrevention !== 'echo-cancel').map(c => c.cellId)};
  const manifestPath = path.join(root, 'iteration.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
  return {root, manifest, manifestPath};
}
test('iteration cannot be accepted by matrix authority or omit explicit worker/signed plan', t => {
  const {root, manifest, manifestPath} = fixture(t);
  const options = {manifest, manifestPath, evidenceRoot: root, currentRuntimeBinaryHashes: [], requireLocalIsolation: false};
  assert.throws(() => verifyStrictMatrixAuthority(options), /schemaVersion/);
  assert.throws(() => verifyStrictAecIterationAuthority(options), /explicit fixed worker/);
  assert.throws(() => verifyStrictAecIterationAuthority({...options, expectedAecWorker: 'vm171'}), /fixed worker/);
  assert.throws(() => verifyStrictAecIterationAuthority({...options, expectedAecWorker: 'vm131'}), /authority|path/);
  for (const mutate of [m => m.releaseEligible = true, m => m.notRunCellIds = [], m => m.matrixVerification = 'passed', m => m.aecWorker = 'vm169']) {
    const changed = structuredClone(manifest); mutate(changed);
    assert.throws(() => verifyStrictAecIterationAuthority({...options, manifest: changed, expectedAecWorker: 'vm131'}));
  }
});
test('AEC verification receipt has a separate kind/path and cannot be consumed as matrix success', t => {
  const {root, manifest, manifestPath} = fixture(t);
  const authority = {executionScope: selection.executionScope, implementationHashes: [], paidImplementationHashes: [], runtimeBinaryHashes: []};
  const {receiptPath, receipt} = writeStrictAecIterationVerificationReceipt({manifestPath, manifest, authority, currentProvenance: null});
  assert.ok(receiptPath.endsWith('.aec-verified.json'));
  assert.equal(receipt.artifactKind, 'watch-mode-strict-aec-c03-iteration-verification');
  assert.ok(!fs.existsSync(manifestPath + '.verified.json'));
  assert.throws(() => validateStrictMatrixVerificationReceipt({receiptPath, manifestPath, manifest, runtimeBinaryHashes: []}), /scope mismatch/);
  const forged = {...receipt, aecWorker: 'vm171'}; fs.writeFileSync(receiptPath, JSON.stringify(forged), 'utf8');
  assert.throws(() => validateStrictAecIterationVerificationReceipt({receiptPath, manifestPath, manifest, runtimeBinaryHashes: []}), /exact signed scope/);
  assert.equal(fs.readdirSync(root).filter(n => n.includes('latest-successful')).length, 0);
});
test('AEC receipt requires every sealed PCM, media/source clock and quality artifact', () => {
  const required = requiredCellArtifactPaths('echo-cancel', 'aec-output-quiescent-v2');
  for (const name of ['media-complete.json', 'aec-source-playback-clock.jsonl', 'aec-threshold-freeze.json', 'aec-desktop-playback-timeline-terminal.json',
    'aec-closed-loop-evidence.json', 'aec-closed-loop-terminal.json', 'aec-closed-loop-metadata.jsonl',
    'aec-physical-output-48k-stereo.f32le', 'aec-provider-input.s16le', 'aec-source-reference-48k-mono.f32le',
    'aec-render-reference-48k-stereo.f32le', 'aec-pre-capture-48k-stereo.f32le',
    'aec-post-output-48k-stereo.f32le', 'aec-frame-metadata.jsonl', 'aec-terminal.json']) {
    assert.ok(required.includes(name), name);
  }
  assert.ok(!requiredCellArtifactPaths('process-exclusion').includes('media-complete.json'));
});
test('independent iteration writer never leaves a matrix-named staged manifest or marks unrun cells pass', t => {
  const {root, manifest} = fixture(t);
  const run = writeAecIterationManifest({releaseSelection: selection, runDirectories: ['c03'], releaseCells: manifest.cells,
    shardExecution: {executionId: 'scope-only'}}, {writeManifest: () => {
      const manifestPath = path.join(root, 'watch-mode-live-matrix-staging.json');
      fs.writeFileSync(manifestPath, '{}', 'utf8');
      return {manifestPath, manifest};
    }});
  assert.equal(run.manifest.artifactKind, AEC_ITERATION_MANIFEST_KIND);
  assert.equal(run.manifest.cells.length, 1);
  assert.equal(run.manifest.notRunCellIds.length, 3);
  assert.equal(run.manifest.releaseEligible, false);
  assert.equal(run.manifest.matrixVerification, 'not-run');
  assert.ok(!fs.existsSync(path.join(root, 'watch-mode-live-matrix-staging.json')));
});
test('canonical AEC publication rejects a fake or legacy report without publishing any latest matrix index', async t => {
  const {root, manifestPath} = fixture(t);
  await assert.rejects(publishSuccessfulAecIteration({outputRoot: root, manifestPath, verifiedAt: new Date(), currentRuntimeBinaryHashes: []}), /one passed c03/);
  assert.equal(fs.readdirSync(root).filter(n => n.includes('latest-successful') || n.includes('iteration-verified')).length, 0);
});

test('selected 3.8 AEC cannot downgrade completion or adopt a legacy c03 report', () => {
  assert.throws(() => assertStrictAecClosedLoopAuthority({
    runDirectory: 'must-not-read-legacy-report',
    cell: {feedbackLoopPrevention: 'echo-cancel', modelId: 'qwen3.8-livetranslate-flash-realtime', completionPolicy: 'media-input-complete-v1'},
  }), /cannot adopt a legacy completion policy/);
  assert.equal(assertStrictAecClosedLoopAuthority({
    runDirectory: 'historical-only',
    cell: {feedbackLoopPrevention: 'echo-cancel', modelId: 'qwen3.5-livetranslate-flash-realtime'},
  }), null); // not a v2 quality verdict, and never counts towards the iteration.
});
