import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildIntegrationEnvironment,
  defaultAudioTimeoutSeconds,
  maximumAudioTimeoutSeconds,
  parseLlmIntegrationArgs,
  validateAudioTimeoutSeconds,
} from './run-llm-integration.mjs';

test('audio-only CLI defaults to a 300 second hard timeout', () => {
  const args = parseLlmIntegrationArgs(['--audio-only']);

  assert.equal(args.audioOnly, true);
  assert.equal(args.timeoutSeconds, 300);
  assert.equal(defaultAudioTimeoutSeconds, 300);
  assert.ok(defaultAudioTimeoutSeconds < maximumAudioTimeoutSeconds);
});

test('audio-only timeout accepts 600 seconds but rejects larger or invalid values', () => {
  assert.equal(validateAudioTimeoutSeconds('600'), 600);
  for (const value of ['600.01', '0', '-1', 'not-a-number']) {
    assert.throws(() => validateAudioTimeoutSeconds(value), /no more than 600/);
  }
});

test('audio-only mode is passed privately and does not leak into the full suite', () => {
  const previous = process.env.OMNI_LLM_TEST_AUDIO_ONLY;
  process.env.OMNI_LLM_TEST_AUDIO_ONLY = 'inherited';
  try {
    const config = { environment: { TEST_ONLY_KEY: 'placeholder' } };
    const audioEnvironment = buildIntegrationEnvironment({
      config,
      requestedConfig: 'test-config.json',
      audioOnly: true,
    });
    const fullEnvironment = buildIntegrationEnvironment({
      config,
      requestedConfig: 'test-config.json',
      audioOnly: false,
    });

    assert.equal(audioEnvironment.OMNI_LLM_TEST_AUDIO_ONLY, '1');
    assert.equal(fullEnvironment.OMNI_LLM_TEST_AUDIO_ONLY, undefined);
  } finally {
    if (previous === undefined) delete process.env.OMNI_LLM_TEST_AUDIO_ONLY;
    else process.env.OMNI_LLM_TEST_AUDIO_ONLY = previous;
  }
});
