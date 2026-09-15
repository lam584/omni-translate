import { describe, expect, it } from 'vitest';

import authorizationVectors from '../../../../contracts/model-protocol-authorization-v1.vectors.json';
import {
  MODEL_PROTOCOL_REGISTRY,
  admitModelProtocolEvent,
  authorizeModelProtocolInvocation,
  lookupModelProtocolProfiles,
  type ModelProtocolAuthorizationRequest,
  type ModelProtocolRegistry,
} from './profile-registry';

describe('Bailian model protocol profile registry', () => {
  it('uses the shared cross-language fail-closed authorization vectors', () => {
    for (const vector of authorizationVectors.vectors) {
      const result = authorizeModelProtocolInvocation(vector.request as ModelProtocolAuthorizationRequest);
      expect(result.ok, vector.id).toBe(vector.expect.ok);
      if (vector.expect.ok) {
        expect(result, vector.id).toMatchObject({
          ok: true,
          authorization: {
            profileId: vector.expect.profileId,
            profileVersion: vector.expect.profileVersion,
            wireDialect: vector.expect.wireDialect,
            endpointFamily: vector.expect.endpointFamily,
            endpointHostFamilyId: vector.expect.endpointHostFamilyId,
            terminalLifecycle: vector.expect.terminalLifecycle,
          },
        });
      } else {
        expect(result, vector.id).toEqual({ ok: false, errorCode: vector.expect.errorCode });
      }
    }
  });

  it('returns a complete production authority rather than a boolean', () => {
    const result = authorizeModelProtocolInvocation({
      exactModelId: 'qwen3.5-livetranslate-flash-realtime',
      operation: 'native_translate',
      transport: 'websocket',
      region: 'cn-beijing',
      endpointHost: 'dashscope.aliyuncs.com',
    });
    expect(result).toMatchObject({
      ok: true,
      authorization: {
        registryVersion: 'bailian-model-protocol-registry/v1',
        registryCheckedAt: '2026-08-30',
        providerFamily: 'bailian',
        exactModelId: 'qwen3.5-livetranslate-flash-realtime',
        profileId: 'bailian.livetranslate.realtime.ws',
        profileVersion: 1,
        product: 'qwen3.5-livetranslate-realtime',
        operation: 'native_translate',
        transport: 'websocket',
        region: 'cn-beijing',
        endpointHost: 'dashscope.aliyuncs.com',
        endpointHostFamilyId: 'dashscope-cn-beijing-generic',
        endpointFamily: 'dashscope-realtime-v1',
        endpointPath: '/api-ws/v1/realtime',
        modelPlacement: 'query',
        wireDialect: 'bailian-livetranslate-session-ws-v1',
        wireDialectVersion: 1,
        inputFraming: 'json-base64',
        outputFraming: 'json-base64',
        previewSemantics: 'replaceable-snapshot',
        terminalLifecycle: 'session.finish->session.finished',
        reusePolicy: 'single-session',
        regionPolicy: 'region-key-endpoint-model-must-match',
        adapterId: 'desktop-livetranslate-session-v1',
        wireFixture: 'apps/desktop/src-tauri/fixtures/model-protocol/livetranslate-session.json',
      },
    });
    if (!result.ok) throw new Error(result.errorCode);
    expect(result.authorization.audioInput).toEqual({
      required: true,
      codecs: ['pcm16', 'opus'],
      sampleRatesHz: [8000, 16000],
      channels: [1],
    });
    expect(result.authorization.clientEventTypes).toContain('session.finish');
    expect(result.authorization.serverEventTypes).toContain('response.created');
    expect(result.authorization.serverEventTypes).not.toContain('response.text.delta');
    expect(result.authorization.textEventSemantics).toContainEqual(expect.objectContaining({
      eventType: 'response.text.text',
      updateMode: 'replaceable-snapshot',
      previewFields: ['text', 'stash'],
      finalEventType: 'response.text.done',
    }));
  });

  it('keeps inspection separate from connection authority', () => {
    const profiles = lookupModelProtocolProfiles('qwen3-asr-flash-realtime');
    expect(profiles).toHaveLength(1);
    expect(profiles[0].adapter.status).toBe('manifest-only');
    expect(authorizeModelProtocolInvocation({
      exactModelId: 'qwen3-asr-flash-realtime',
      operation: 'asr',
      transport: 'websocket',
      region: 'cn-beijing',
      endpointHost: 'dashscope.aliyuncs.com',
    })).toEqual({ ok: false, errorCode: 'model_protocol.adapter_unavailable' });
  });

  it('admits only the authorized dialect event set before state mutation', () => {
    const result = authorizeModelProtocolInvocation({
      exactModelId: 'qwen3.5-livetranslate-flash-realtime',
      operation: 'native_translate',
      transport: 'websocket',
      region: 'cn-beijing',
      endpointHost: 'dashscope.aliyuncs.com',
    });
    if (!result.ok) throw new Error(result.errorCode);

    expect(admitModelProtocolEvent(result.authorization, {
      direction: 'server',
      eventType: 'response.created',
      frameKind: 'json',
    })).toMatchObject({ ok: true, admission: { eventType: 'response.created' } });
    expect(admitModelProtocolEvent(result.authorization, {
      direction: 'server',
      eventType: 'response.text.text',
      frameKind: 'json',
    })).toMatchObject({ ok: true, admission: { eventType: 'response.text.text' } });
    expect(admitModelProtocolEvent(result.authorization, {
      direction: 'server',
      eventType: 'response.text.delta',
      frameKind: 'json',
    })).toEqual({ ok: false, errorCode: 'model_protocol.event_not_allowed' });
    expect(admitModelProtocolEvent(result.authorization, {
      direction: 'server',
      eventType: 'response.audio.delta',
      frameKind: 'json',
    })).toEqual({ ok: false, errorCode: 'model_protocol.frame_kind_mismatch' });
    expect(admitModelProtocolEvent(result.authorization, {
      direction: 'server',
      eventType: 'response.audio.delta',
      frameKind: 'json-base64',
    })).toMatchObject({ ok: true, admission: { eventType: 'response.audio.delta' } });
  });

  it('rejects a forged authorization envelope before event admission', () => {
    const result = authorizeModelProtocolInvocation({
      exactModelId: 'qwen3.5-livetranslate-flash-realtime',
      operation: 'native_translate',
      transport: 'websocket',
      region: 'cn-beijing',
      endpointHost: 'dashscope.aliyuncs.com',
    });
    if (!result.ok) throw new Error(result.errorCode);
    expect(admitModelProtocolEvent({
      ...result.authorization,
      terminalLifecycle: 'owner-close-after-response-drain',
    }, {
      direction: 'server',
      eventType: 'response.text.text',
      frameKind: 'json',
    })).toEqual({ ok: false, errorCode: 'model_protocol.authorization_identity_mismatch' });
  });

  it('does not normalize case, whitespace, or unknown snapshots into authority', () => {
    for (const exactModelId of [
      'QWEN3.5-LIVETRANSLATE-FLASH-REALTIME',
      ' qwen3.5-livetranslate-flash-realtime',
      'qwen3.5-livetranslate-flash-realtime-2099-12-31',
    ]) {
      expect(authorizeModelProtocolInvocation({
        exactModelId,
        operation: 'native_translate',
        transport: 'websocket',
        region: 'cn-beijing',
        endpointHost: 'dashscope.aliyuncs.com',
      })).toEqual({ ok: false, errorCode: 'model_protocol.model_not_registered' });
    }
  });

  it('rejects an ambiguous model even when both profiles otherwise look valid', () => {
    const duplicatedProfile = {
      ...MODEL_PROTOCOL_REGISTRY.profiles[0],
      profileId: 'bailian.livetranslate.realtime.ws.duplicate',
    };
    const registry: ModelProtocolRegistry = {
      ...MODEL_PROTOCOL_REGISTRY,
      profiles: [...MODEL_PROTOCOL_REGISTRY.profiles, duplicatedProfile],
    };
    expect(authorizeModelProtocolInvocation({
      exactModelId: 'qwen3.5-livetranslate-flash-realtime',
      operation: 'native_translate',
      transport: 'websocket',
      region: 'cn-beijing',
      endpointHost: 'dashscope.aliyuncs.com',
    }, registry)).toEqual({ ok: false, errorCode: 'model_protocol.profile_ambiguous' });
  });
});
