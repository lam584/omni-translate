/**
 * Provider runtime contract. The type shapes are GENERATED from the Rust
 * contract structs (see ./generated/provider-runtime.ts and the
 * contract_export cargo test); this module re-exports them and keeps the
 * pinned cross-process event name.
 */
export type {
  CredentialDirectResultEvent,
  CredentialRefStatus,
  CredentialSecretPayload,
  ProviderModelCatalogRuntime,
  ProviderModelRuntime,
  ProviderProbeCheckRuntime,
  ProviderProbeProfileRuntime,
  ProviderRoutingDecision,
  ProviderRuntimeError,
  ProviderSmokeResult,
  ProviderStreamEventRecord,
} from './generated/provider-runtime';

export const CREDENTIAL_DIRECT_RESULT_EVENT = 'credential://direct-result';
