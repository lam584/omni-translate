import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WATCH_MODEL_PROTOCOL_IDENTITY_FIELDS,
  assertWatchModelProtocolIdentity,
  authorizeWatchModelProtocolIdentity,
  deriveWatchModelProtocolIdentity,
  watchModelProtocolIdentityFailure,
} from './watch-mode-model-protocol-authority.mjs';
import { currentPaidAuthorityImplementationHashes } from './watch-mode-evidence-authority.mjs';

const LIVETRANSLATE_MODEL = 'qwen3.5-livetranslate-flash-realtime';

test('derives the exact enabled LiveTranslate identity from the registry authorizer', () => {
  const identity = deriveWatchModelProtocolIdentity(LIVETRANSLATE_MODEL);
  assert.deepEqual(Object.keys(identity), [...WATCH_MODEL_PROTOCOL_IDENTITY_FIELDS]);
  assert.deepEqual(identity, {
    registryVersion: 'bailian-model-protocol-registry/v1',
    profileId: 'bailian.livetranslate.realtime.ws',
    profileVersion: 1,
    operation: 'native_translate',
    transport: 'websocket',
    region: 'cn-beijing',
    endpointFamily: 'dashscope-realtime-v1',
    endpointPath: '/api-ws/v1/realtime',
    wireDialect: 'bailian-livetranslate-session-ws-v1',
    wireDialectVersion: 1,
    inputFraming: 'json-base64',
    outputFraming: 'json-base64',
    terminalLifecycle: 'session.finish->session.finished',
    adapterId: 'desktop-livetranslate-session-v1',
    exactModelId: LIVETRANSLATE_MODEL,
  });
});

test('rejects missing and per-field tampered profile identities', () => {
  const expected = deriveWatchModelProtocolIdentity(LIVETRANSLATE_MODEL);
  assert.match(watchModelProtocolIdentityFailure(null, expected), /identity is missing/);
  for (const field of WATCH_MODEL_PROTOCOL_IDENTITY_FIELDS) {
    const tampered = structuredClone(expected);
    tampered[field] = typeof tampered[field] === 'number'
      ? tampered[field] + 1
      : `${tampered[field]}-tampered`;
    assert.throws(
      () => assertWatchModelProtocolIdentity(tampered, expected, 'paid cell profile identity'),
      new RegExp(`${field} mismatch`),
      field,
    );
  }
  assert.throws(
    () => assertWatchModelProtocolIdentity({ ...expected, runnerClaim: true }, expected),
    /fields do not match/,
  );
});

test('rejects unknown and manifest-only Omni models before Watch resources', () => {
  const unknown = authorizeWatchModelProtocolIdentity({ exactModelId: 'unknown-watch-model' });
  assert.deepEqual(unknown, {
    ok: false,
    errorCode: 'model_protocol.model_not_registered',
  });
  const omni = authorizeWatchModelProtocolIdentity({
    exactModelId: 'qwen3.5-omni-plus-realtime',
  });
  assert.deepEqual(omni, {
    ok: false,
    errorCode: 'model_protocol.adapter_unavailable',
  });
});

test('paid authority hash inventory binds the profile registry and authorizers', () => {
  const paths = new Set(currentPaidAuthorityImplementationHashes().map((entry) => entry.path));
  for (const requiredPath of [
    'scripts/testing/watch-mode-model-protocol-authority.mjs',
    'scripts/testing/model-protocol-profile-contract.mjs',
    'contracts/model-protocol-profiles.v1.json',
    'contracts/model-protocol-profiles.schema.json',
  ]) {
    assert.equal(paths.has(requiredPath), true, `missing paid authority hash: ${requiredPath}`);
  }
});
