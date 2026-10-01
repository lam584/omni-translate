import baseline from '../../../../contracts/bailian-model-metadata.generated.json';
import type { ProviderCapability } from '../schema/provider-contract';
import type { ProviderDraft } from '../schema/config';
import { parseRuntimeTimestampMs } from './runtime-timestamp';

export const BAILIAN_METADATA_CACHE_TTL_MS = 10 * 60 * 1000;

export function isBailianMetadataExpired(
  cache: ProviderDraft['modelMetadataCache'] | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!cache?.fetchedAt) return true;
  const fetchedAtMs = parseRuntimeTimestampMs(cache.fetchedAt);
  if (fetchedAtMs === null) return true;
  return nowMs - fetchedAtMs >= BAILIAN_METADATA_CACHE_TTL_MS;
}

export type BailianModelMetadata = {
  modelId: string;
  categories: string[];
  requestModalities: string[];
  responseModalities: string[];
};

/** Directory metadata is advisory. A modality pair alone is never an executable protocol. */
export function capabilitiesFromBailianMetadata(row: BailianModelMetadata): ProviderCapability[] {
  const categories = new Set(row.categories);
  const input = new Set(row.requestModalities);
  const output = new Set(row.responseModalities);
  const result: ProviderCapability[] = [];
  if (categories.has('TG') && input.has('Text') && output.has('Text')) result.push('text-generation');
  if ((categories.has('ASR') || categories.has('Realtime-ASR')) && input.has('Audio') && output.has('Text')) result.push('speech-to-text');
  if ((categories.has('TTS') || categories.has('Realtime-Text-to-Speech')) && input.has('Text') && output.has('Audio')) result.push('text-to-speech');
  if ((categories.has('Realtime-Audio-Translate') || categories.has('Realtime-Omni') || categories.has('Realtime-Chatting'))
    && input.has('Audio') && output.has('Audio')) result.push('speech-to-speech');
  return result;
}

export function bailianMetadataForProvider(provider: ProviderDraft, nowMs?: number): BailianModelMetadata[] {
  if (provider.kind !== 'dashscope') return [];
  const current = provider.modelMetadataCache;
  if (current?.source === 'bailian-api') {
    if (isBailianMetadataExpired(current, nowMs)) return [];
    try {
      const configured = new URL(provider.baseUrl.replace(/^wss:/, 'https:'));
      const fetched = new URL(current.endpoint ?? '');
      const regionMatches = provider.region === 'cn-beijing'
        ? fetched.hostname === 'dashscope.aliyuncs.com' || fetched.hostname.endsWith('.cn-beijing.maas.aliyuncs.com')
        : provider.region === 'ap-southeast-1'
          ? fetched.hostname === 'dashscope-intl.aliyuncs.com' || fetched.hostname.endsWith('.ap-southeast-1.maas.aliyuncs.com')
          : false;
      if (regionMatches && configured.hostname === fetched.hostname && fetched.pathname === '/api/v1/models') return current.models;
    } catch { /* A stale or malformed cache never establishes provider capability. */ }
  }
  const region = provider.region ?? (provider.baseUrl?.includes('cn-beijing') || provider.baseUrl?.includes('dashscope.aliyuncs.com') ? 'cn-beijing' : null);
  if (region !== baseline.region) return [];
  if (baseline.workspaceId) {
    try {
      const hostname = new URL(provider.baseUrl.replace(/^wss:/, 'https:')).hostname;
      if (hostname !== baseline.workspaceId + '.' + baseline.region + '.maas.aliyuncs.com') return [];
    } catch { return []; }
  }
  return baseline.models;
}

