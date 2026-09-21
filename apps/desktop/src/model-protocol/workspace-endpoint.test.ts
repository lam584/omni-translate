import { describe, expect, it } from 'vitest';
import { authorizeModelProtocolInvocation, admitModelProtocolEvent, MODEL_PROTOCOL_REGISTRY } from './profile-registry';

describe('profile-scoped Workspace endpoint requirement', () => {
  const request = { exactModelId: 'qwen3.8-livetranslate-flash-realtime', operation: 'native_translate', transport: 'websocket', region: 'cn-beijing' } as const;
  it.each(['dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com'])('rejects generic %s before I/O with the existing code and workspace_required detail', (endpointHost) => {
    const region = endpointHost.includes('-intl') ? 'ap-southeast-1' : 'cn-beijing';
    expect(authorizeModelProtocolInvocation({ ...request, region, endpointHost })).toMatchObject({ ok: false,
      errorCode: 'model_protocol.endpoint_host_region_mismatch', message: expect.stringContaining('workspace_required') });
  });
  it.each(['cn-beijing', 'ap-southeast-1'] as const)('permits a synthetic workspace in %s and rechecks event authority', (region) => {
    const result = authorizeModelProtocolInvocation({ ...request, region, endpointHost: 'workspace-test.' + region + '.maas.aliyuncs.com' });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.errorCode);
    const event = { direction: 'server', eventType: 'response.text.delta', frameKind: 'json' } as const;
    expect(admitModelProtocolEvent(result.authorization, event).ok).toBe(true);
    const generic = region === 'cn-beijing' ? 'dashscope.aliyuncs.com' : 'dashscope-intl.aliyuncs.com';
    expect(admitModelProtocolEvent({ ...result.authorization, endpointHost: generic,
      endpointHostFamilyId: region === 'cn-beijing' ? 'dashscope-cn-beijing-generic' : 'dashscope-ap-southeast-1-generic' }, event).ok).toBe(false);
  });
  it.each(['cn-beijing.maas.aliyuncs.com', 'a.b.cn-beijing.maas.aliyuncs.com', 'workspace-test.cn-beijing.maas.aliyuncs.com.evil.invalid', '-bad.cn-beijing.maas.aliyuncs.com', 'workspace-test.ap-southeast-1.maas.aliyuncs.com'])('does not broaden the allowlist for %s', (endpointHost) => {
    expect(authorizeModelProtocolInvocation({ ...request, endpointHost }).ok).toBe(false);
  });
  it('leaves absent metadata and all 3.5 app host semantics unchanged', () => {
    expect(MODEL_PROTOCOL_REGISTRY.profiles.filter((profile) => profile.endpointRequirements).map((profile) => profile.profileId))
      .toEqual(['bailian.livetranslate.3_8.realtime.ws']);
    for (const endpointHost of ['dashscope.aliyuncs.com', 'workspace-test.cn-beijing.maas.aliyuncs.com']) {
      expect(authorizeModelProtocolInvocation({ ...request, exactModelId: 'qwen3.5-livetranslate-flash-realtime', endpointHost }).ok).toBe(true);
    }
    const registry = structuredClone(MODEL_PROTOCOL_REGISTRY);
    delete registry.profiles.find((profile) => profile.exactModelIds.includes(request.exactModelId))!.endpointRequirements;
    expect(authorizeModelProtocolInvocation({ ...request, endpointHost: 'dashscope.aliyuncs.com' }, registry).ok).toBe(true);
  });
});
