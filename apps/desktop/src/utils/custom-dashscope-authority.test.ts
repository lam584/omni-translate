import { describe, expect, it } from 'vitest';
import { appConfigDraftMock } from '../mocks/app-config';
import { authorizedCustomDashScopeRealtime } from './custom-dashscope-authority';
import { MODEL_PROTOCOL_REGISTRY, type ModelProtocolOperation } from '../model-protocol/profile-registry';

function provider() {
  return {
    ...structuredClone(appConfigDraftMock.providers[0]),
    templateId: 'template-custom-bailian', templateSource: 'custom' as const,
    kind: 'dashscope' as const, transport: 'websocket' as const,
    region: 'cn-beijing', baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    authRef: { ...appConfigDraftMock.providers[0]!.authRef, headerName: 'Authorization', scheme: 'bearer' as const },
  };
}

describe('custom DashScope native authority', () => {
  it('recognizes a known realtime model at its official regional URL', () => {
    const authority = authorizedCustomDashScopeRealtime(provider(), 'qwen3.5-livetranslate-flash-realtime');
    expect(authority?.wireDialect).toBe('bailian-livetranslate-session-ws-v1');
  });
  it('requires the registered Workspace host for the 3.8 model', () => {
    const draft = provider();
    expect(authorizedCustomDashScopeRealtime(draft, 'qwen3.8-livetranslate-flash-realtime')).toBeNull();
    draft.baseUrl = 'wss://my-workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime';
    expect(authorizedCustomDashScopeRealtime(draft, 'qwen3.8-livetranslate-flash-realtime')?.wireDialect)
      .toBe('bailian-livetranslate-session-ws-v2');
  });
  it('rejects lookalike hosts, credentials in URLs, foreign regions, unknown models and wrong auth', () => {
    const draft = provider();
    for (const url of [
      'https://dashscope.aliyuncs.com.evil.test/api/v1',
      'https://dashscope.aliyuncs.com@evil.test/api/v1',
      'https://dashscope.aliyuncs.com:8443/api/v1',
      'http://dashscope.aliyuncs.com/api/v1',
    ]) {
      draft.baseUrl = url;
      expect(authorizedCustomDashScopeRealtime(draft, 'qwen3.5-livetranslate-flash-realtime')).toBeNull();
    }
    draft.baseUrl = 'https://dashscope.aliyuncs.com/api/v1';
    expect(authorizedCustomDashScopeRealtime(draft, 'unregistered-model')).toBeNull();
    draft.region = 'ap-southeast-1';
    expect(authorizedCustomDashScopeRealtime(draft, 'qwen3.5-livetranslate-flash-realtime')).toBeNull();
    draft.region = 'cn-beijing';
    const wrongAuth = { ...draft, authRef: { ...draft.authRef, scheme: 'api-key' as const } };
    expect(authorizedCustomDashScopeRealtime(wrongAuth, 'qwen3.5-livetranslate-flash-realtime')).toBeNull();
  });
});


const NATIVE_OPERATIONS: ModelProtocolOperation[] = ['dialogue', 'asr', 'tts', 'native_translate'];
const APPROVED_FAMILIES = MODEL_PROTOCOL_REGISTRY.profiles.flatMap((profile) => {
  const dialect = MODEL_PROTOCOL_REGISTRY.dialects.find((item) => item.dialectId === profile.dialectId);
  if (profile.adapter.status !== 'enabled' || !profile.adapter.adapterId || dialect?.transport !== 'websocket') return [];
  return profile.exactModelIds.flatMap((modelId) => profile.operations.filter((operation) => NATIVE_OPERATIONS.includes(operation))
    .map((operation) => ({ modelId, operation, profile, dialect })));
});

function familyProvider(workspace: boolean, region = 'cn-beijing') {
  const draft = provider();
  draft.region = region;
  const host = workspace ? 'my-workspace.' + region + '.maas.aliyuncs.com'
    : region === 'cn-beijing' ? 'dashscope.aliyuncs.com' : 'dashscope-intl.aliyuncs.com';
  draft.baseUrl = 'https://' + host + '/api/v1';
  return draft;
}

describe('compiled custom DashScope native operation families', () => {
  it.each(APPROVED_FAMILIES)('admits $modelId for only its compiled $operation operation', ({ modelId, operation, profile, dialect }) => {
    const draft = familyProvider(!!profile.endpointRequirements?.workspaceScoped);
    const authority = authorizedCustomDashScopeRealtime(draft, modelId, operation);
    expect(authority).toMatchObject({
      exactModelId: modelId, operation, profileId: profile.profileId, profileVersion: profile.profileVersion,
      wireDialect: dialect.dialectId, endpointPath: dialect.endpointPath, adapterId: profile.adapter.adapterId,
    });
    // Legacy two-argument callers can recognize a single approved native operation.
    expect(authorizedCustomDashScopeRealtime(draft, modelId)?.operation).toBe(operation);
    for (const wrongOperation of NATIVE_OPERATIONS.filter((item) => !profile.operations.includes(item))) {
      expect(authorizedCustomDashScopeRealtime(draft, modelId, wrongOperation)).toBeNull();
    }
  });

  it.each(APPROVED_FAMILIES)('constructs $modelId exact operation endpoint from shared official bases', ({ modelId, operation, profile, dialect }) => {
    const draft = familyProvider(!!profile.endpointRequirements?.workspaceScoped);
    const origin = new URL(draft.baseUrl).origin;
    for (const path of ['/', '/api/v1', '/compatible-mode/v1', dialect.endpointPath, dialect.endpointPath + '/']) {
      draft.baseUrl = origin + path;
      expect(authorizedCustomDashScopeRealtime(draft, modelId, operation)?.endpointPath).toBe(dialect.endpointPath);
    }
    draft.baseUrl = origin + (dialect.endpointPath === '/api-ws/v1/inference' ? '/api-ws/v1/realtime' : '/api-ws/v1/inference');
    expect(authorizedCustomDashScopeRealtime(draft, modelId, operation)?.endpointPath).toBe(dialect.endpointPath);
  });

  it.each(APPROVED_FAMILIES)('retains compiled host/region/workspace policy for $modelId', ({ modelId, operation, profile }) => {
    const workspace = !!profile.endpointRequirements?.workspaceScoped;
    for (const region of profile.regions) {
      const draft = familyProvider(workspace, region);
      expect(authorizedCustomDashScopeRealtime(draft, modelId, operation)?.region).toBe(region);
      draft.region = region === 'cn-beijing' ? 'ap-southeast-1' : 'cn-beijing';
      expect(authorizedCustomDashScopeRealtime(draft, modelId, operation)).toBeNull();
    }
    const draft = familyProvider(workspace);
    draft.region = 'us-east-1';
    expect(authorizedCustomDashScopeRealtime(draft, modelId, operation)).toBeNull();
    if (workspace) {
      expect(authorizedCustomDashScopeRealtime(familyProvider(false), modelId, operation)).toBeNull();
      draft.region = 'cn-beijing';
      for (const host of ['cn-beijing.maas.aliyuncs.com', 'nested.workspace.cn-beijing.maas.aliyuncs.com', 'workspace.cn-beijing.maas.aliyuncs.com.evil.test']) {
        draft.baseUrl = 'https://' + host + '/api/v1';
        expect(authorizedCustomDashScopeRealtime(draft, modelId, operation)).toBeNull();
      }
    }
  });

  it.each(APPROVED_FAMILIES)('rejects URL/auth/transport/provenance spoofing for $modelId', ({ modelId, operation, profile }) => {
    const valid = familyProvider(!!profile.endpointRequirements?.workspaceScoped);
    const host = new URL(valid.baseUrl).hostname;
    for (const url of [
      'https://' + host + '.evil.test/api/v1', 'https://' + host + '@evil.test/api/v1',
      'https://user:password@' + host + '/api/v1', 'https://' + host + ':8443/api/v1',
      'http://' + host + '/api/v1', 'ws://' + host + '/api/v1',
      'https://' + host + '/api/v1?key=secret', 'https://' + host + '/api/v1#other',
      'https://' + host + '/unapproved/path', 'https://' + host + '/api-ws/v1/inference/other',
      'https://' + host + '/api-ws/v1/%69nference',
    ]) {
      expect(authorizedCustomDashScopeRealtime({ ...valid, baseUrl: url }, modelId, operation)).toBeNull();
    }
    for (const authRef of [
      { ...valid.authRef, scheme: 'api-key' as const }, { ...valid.authRef, scheme: 'none' as const },
      { ...valid.authRef, headerName: 'X-Api-Key' }, { ...valid.authRef, headerName: 'Authorization ' },
    ]) expect(authorizedCustomDashScopeRealtime({ ...valid, authRef }, modelId, operation)).toBeNull();
    expect(authorizedCustomDashScopeRealtime({ ...valid, transport: 'http' }, modelId, operation)).toBeNull();
    expect(authorizedCustomDashScopeRealtime({ ...valid, transport: 'streaming-http' }, modelId, operation)).toBeNull();
    expect(authorizedCustomDashScopeRealtime({ ...valid, kind: 'openai-compatible' }, modelId, operation)).toBeNull();
    expect(authorizedCustomDashScopeRealtime({ ...valid, templateSource: 'official' }, modelId, operation)).toBeNull();
    expect(authorizedCustomDashScopeRealtime({ ...valid, baseUrl: 'wss://' + host + '/api/v1', authRef: { ...valid.authRef, headerName: 'authorization' } }, modelId, operation)?.operation).toBe(operation);
  });

  it('does not turn manifest-only, unknown, renamed or whitespace models into native authority', () => {
    for (const profile of MODEL_PROTOCOL_REGISTRY.profiles.filter((item) => item.adapter.status !== 'enabled')) {
      const draft = familyProvider(!!profile.endpointRequirements?.workspaceScoped);
      for (const modelId of profile.exactModelIds) {
        expect(authorizedCustomDashScopeRealtime(draft, modelId)).toBeNull();
        for (const operation of NATIVE_OPERATIONS) expect(authorizedCustomDashScopeRealtime(draft, modelId, operation)).toBeNull();
      }
    }
    for (const modelId of ['', 'qwen-audio-3.1-realtime-flash', 'qwen-audio-3.0-tts-plus-spoof', 'Qwen-Audio-3.0-tts-plus', ' qwen-audio-3.0-tts-plus', 'qwen-audio-3.0-tts-plus ']) {
      expect(authorizedCustomDashScopeRealtime(provider(), modelId)).toBeNull();
    }
    for (const unsupported of ['voice_clone', 'file_translate'] as const) {
      expect(authorizedCustomDashScopeRealtime(provider(), 'qwen3.5-livetranslate-flash-realtime', unsupported)).toBeNull();
    }
  });
});
