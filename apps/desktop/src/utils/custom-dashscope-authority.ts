import type { ProviderDraft } from '../schema/config';
import {
  authorizeModelProtocolInvocation,
  lookupModelProtocolProfiles,
  MODEL_PROTOCOL_REGISTRY,
  type AuthorizedModelProtocolProfile,
  type ModelProtocolRegion,
  type ModelProtocolOperation,
} from '../model-protocol/profile-registry';

const NATIVE_OPERATIONS: readonly ModelProtocolOperation[] = ['dialogue', 'asr', 'tts', 'native_translate'];
const SHARED_BASE_PATHS = ['/', '/api/v1', '/compatible-mode/v1', '/api-ws/v1/realtime', '/api-ws/v1/inference'];

/**
 * Admit an exact, compiled native operation at an official Bailian endpoint.
 * An explicit operation cannot inherit a different operation's authority. The
 * legacy two-argument form returns authority only for one unambiguous approved
 * native operation, so display/admission callers retain their existing API.
 */
export function authorizedCustomDashScopeRealtime(
  provider: ProviderDraft,
  modelId: string,
  operation?: ModelProtocolOperation,
): AuthorizedModelProtocolProfile | null {
  if (provider.templateSource !== 'custom' || provider.kind !== 'dashscope' || provider.transport !== 'websocket'
    || provider.authRef.headerName.toLowerCase() !== 'authorization' || provider.authRef.scheme !== 'bearer'
    || (operation !== undefined && !NATIVE_OPERATIONS.includes(operation))) return null;
  let endpoint: URL;
  try { endpoint = new URL(provider.baseUrl); } catch { return null; }
  const path = endpoint.pathname.replace(/\/$/, '') || '/';
  if (!['https:', 'wss:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.port
    || endpoint.search || endpoint.hash) return null;
  const candidates = lookupModelProtocolProfiles(modelId).flatMap((profile) => {
    const dialect = MODEL_PROTOCOL_REGISTRY.dialects.find((item) => item.dialectId === profile.dialectId);
    if (profile.adapter.status !== 'enabled' || !profile.adapter.adapterId || dialect?.transport !== 'websocket'
      || (!SHARED_BASE_PATHS.includes(path) && dialect.endpointPath !== path)) return [];
    // The profile schema, not the saved base path, owns the actual operation
    // endpoint. A shared platform may contain realtime and inference models.
    return profile.operations.filter((candidate) => NATIVE_OPERATIONS.includes(candidate)
      && (operation === undefined || candidate === operation)).map((candidate) => ({ profile, operation: candidate }));
  });
  if (candidates.length !== 1) return null;
  const selected = candidates[0];
  const result = authorizeModelProtocolInvocation({
    exactModelId: modelId,
    operation: selected.operation,
    transport: 'websocket',
    region: provider.region as ModelProtocolRegion,
    endpointHost: endpoint.hostname,
    declaredProfileId: selected.profile.profileId,
    declaredProfileVersion: selected.profile.profileVersion,
  });
  return result.ok ? result.authorization : null;
}
