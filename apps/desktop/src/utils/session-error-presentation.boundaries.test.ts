import { describe, expect, it } from 'vitest';
import { parseModelContext, sessionLaunchErrorCode } from './session-error-presentation';

describe('untrusted model-context parsing boundaries', () => {
  it.each([
    ['Conversation output model', 'primary-audio'], ['对话输出模型', 'primary-audio'],
    ['Primary text model', 'primary-text'], ['subtitleTranslationModelId', 'secondary-subtitle'],
    ['语音播报模型', 'speech-output'],
  ])('recovers the role from %s without inventing model identity', (text, role) => {
    expect(parseModelContext(null, text)).toEqual({ context: { modelRole: role }, modelProtocolCode: null, cleanedDetail: text });
  });

  it.each([null, 42, 'invalid', { unrelated: true }])('ignores unsupported structured details %j', (details) => {
    expect(parseModelContext({ details, message: 42 })).toEqual({ context: null, modelProtocolCode: null, cleanedDetail: '' });
  });

  it('preserves structured identity when optional fields have the wrong type, and does not infer an invalid domain', () => {
    const details = { modelReference: 'custom::exact', modelId: 7, providerId: 9, direction: false };
    expect(parseModelContext({ details, code: 1 }).context).toMatchObject(details);
    expect(sessionLaunchErrorCode({ code: 'provider_manifest.not_authorized' }, '')).toBe('session.model-reference-invalid');
    expect(sessionLaunchErrorCode({ code: 42 }, 'ordinary error')).toBe('session.launch-precheck-failed');
  });

  it.each(['null', '7', '"text"', '{invalid'])('strips malformed/non-object inline modelContext %s without creating a context', (json) => {
    const text = `failure | modelContext: ${json} | code: session.network-unreachable`;
    expect(parseModelContext(undefined, text)).toEqual({ context: null, modelProtocolCode: null, cleanedDetail: 'failure | code: session.network-unreachable' });
  });
});
