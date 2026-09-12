import assert from 'node:assert/strict';
import test from 'node:test';

import { strictWatchSessionReportFailure } from './verify-watch-mode-evidence.mjs';

test('F01 strict_report_rejects_missing_model_protocol_profile_identity', () => {
  const reportWithoutProtocolIdentity = {
    realtimeSession: {
      readinessEvent: 'session.updated',
    },
    watchSessionReport: {
      sessionId: 'bailian-old-red-local-fixture',
      status: 'completed',
      elapsedMs: 120_000,
      summary: {
        durationMs: 120_000,
        unrenderedCueCount: 0,
        cueCount: 1,
      },
      cues: [{
        cueId: 'cue-1',
        comparisonStatus: 'exact',
        llmFirstAtMs: 100,
        publishedFirstAtMs: 150,
        renderedFirstAtMs: 175,
        llmFirstToRenderMs: 75,
        publishToRenderMs: 25,
        issues: [],
      }],
    },
  };

  assert.equal(
    Object.hasOwn(reportWithoutProtocolIdentity.watchSessionReport, 'modelProtocolProfileId'),
    false,
    'fixture must omit the model protocol identity under test',
  );
  assert.match(
    strictWatchSessionReportFailure(reportWithoutProtocolIdentity),
    /model protocol profile identity.*missing/i,
  );
});
