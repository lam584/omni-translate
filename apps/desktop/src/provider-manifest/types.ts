import type { ProviderCapability } from '../schema/provider-contract';

export type ProviderManifestMaturity =
  | 'ga'
  | 'preview'
  | 'experimental'
  | 'enterprise-only'
  | 'deprecated'
  | 'unspecified';
export type ProviderManifestVerification = 'live-verified' | 'fixture-only' | 'not-implemented';
export type ProviderManifestOperation =
  | 'text'
  | 'text-translation'
  | 'asr'
  | 'tts'
  | 'realtime-conversation'
  | 'realtime-translation'
  | 'realtime-transcription'
  | 'voice-clone';

export type ProviderManifestCapability = ProviderCapability
  | 'text-translation'
  | 'speech-translation'
  | 'realtime-transcription'
  | 'file-transcription'
  | 'voice-clone';

export type ProviderManifestTransportKind = 'http' | 'sse' | 'websocket' | 'webrtc';

export type ProviderManifestDocumentation = {
  id: string;
  title: string;
  url: string;
  checkedAt: string;
};

export type ProviderManifestCredential = {
  id: string;
  reference: string;
  fields: Array<{
    id: string;
    label: string;
    secret: boolean;
    required: boolean;
    format?: string;
  }>;
};

export type ProviderManifestAuthProfile = {
  id: string;
  type:
    | 'bearer'
    | 'token'
    | 'api-key'
    | 'multi-header-api-key'
    | 'query-key'
    | 'hmac-sha1-query'
    | 'hmac-sha256-query'
    | 'hmac-sha256-header'
    | 'azure-entra'
    | 'signed-binary';
  credentialId: string;
  parameters: Array<{
    location: 'header' | 'query' | 'path' | 'binary-header';
    name: string;
    source: 'credential' | 'static' | 'derived';
    credentialFieldId?: string;
    staticValue?: string;
    derivation?: string;
    scheme?: string;
    required: boolean;
  }>;
  signing?: {
    algorithm: 'hmac-sha1' | 'hmac-sha256' | 'provider-defined';
    canonicalization: string;
    signatureEncoding: 'hex' | 'base64' | 'base64url' | 'binary';
    signatureParameterName: string;
    signedParameterNames?: string[];
  };
  credentialBootstrap?: {
    kind: 'jwt-derivation' | 'oauth2' | 'ephemeral-token-exchange';
    endpointTemplate?: string;
    scope?: string;
    description: string;
    documentationIds: string[];
  };
};

export type ProviderManifestWireEnvelope = {
  kind: 'none' | 'length-prefixed' | 'typed-header' | 'provider-defined';
  id?: string;
  byteOrder?: 'big-endian' | 'little-endian' | 'not-applicable';
  description?: string;
};

export type ProviderManifestTransport = {
  id: string;
  kind: ProviderManifestTransportKind;
  requestFraming: 'json' | 'none' | 'multipart' | 'json-base64' | 'binary' | 'protobuf' | 'audio' | 'json-and-binary' | 'sdp';
  responseFraming: 'json' | 'sse' | 'audio' | 'json-base64' | 'binary' | 'protobuf' | 'json-and-binary' | 'sdp';
  requestEnvelope: ProviderManifestWireEnvelope;
  responseEnvelope: ProviderManifestWireEnvelope;
};

export type ProviderManifestAudioDirection = {
  required: boolean;
  formats: string[];
  sampleRatesHz: number[];
  channels: number[];
  bitDepths?: number[];
  endianness?: Array<'little-endian' | 'big-endian' | 'not-applicable'>;
  chunkDurationMs?: {
    minimum?: number;
    maximum?: number;
    recommended?: number;
  };
};

export type ProviderManifestAudioProfile = {
  id: string;
  input: ProviderManifestAudioDirection;
  output: ProviderManifestAudioDirection;
};

export type ProviderManifestLifecycleProfile = {
  id: string;
  handshake: string[];
  clientEvents: string[];
  serverEvents: string[];
  vadModes: Array<'none' | 'manual' | 'server-vad' | 'semantic-vad' | 'client-activity'>;
  terminal: string;
  reuse: 'single-request' | 'single-session' | 'multi-turn' | 'sequential-tasks';
  idleTimeoutSeconds?: number | null;
  textDeltaSemantics?: 'append-delta' | 'replaceable-snapshot' | 'mixed' | 'not-applicable';
};

export type ProviderManifestApiFamily = {
  id: string;
  displayName: string;
  baseUrlTemplate: string;
  endpointTemplate: string | null;
  endpointStatus: 'verified' | 'unresolved' | 'deprecated';
  modelAddressing: 'model-id' | 'deployment-id' | 'path-deployment' | 'none';
  apiVersion?: string | null;
  transportId: string;
  authProfileIds: string[];
  defaultAuthProfileId: string;
  maturity: ProviderManifestMaturity;
  documentationIds: string[];
};

export type ProviderManifestProtocolProfile = {
  id: string;
  version: number;
  apiFamilyId: string;
  transportId: string;
  authProfileIds: string[];
  defaultAuthProfileId: string;
  audioProfileId?: string;
  lifecycleProfileId: string;
  operations: ProviderManifestOperation[];
  capabilities: ProviderManifestCapability[];
  maturity: ProviderManifestMaturity;
  adapter: {
    id: string;
    status: 'enabled' | 'disabled';
    verification: ProviderManifestVerification;
    reason?: string;
  };
  documentationIds: string[];
  fixtureIds: string[];
  legacyProtocolIds?: string[];
  customProviderPolicy?: 'forbidden' | 'explicit-profile';
  customEndpointPolicy?: 'absolute-secure-url-no-userinfo';
  notes?: string;
};

export type ProviderManifestModel = {
  id: string;
  displayName: string;
  aliases?: string[];
  capabilities: ProviderManifestCapability[];
  maturity: ProviderManifestMaturity;
  protocolBindings: Array<{
    operation: ProviderManifestOperation;
    protocolProfileId: string;
    protocolProfileVersion: number;
  }>;
  documentationIds: string[];
  availability?: string;
};

export type ProviderManifest = {
  $schema: '../../contracts/provider-manifest.schema.json';
  schemaVersion: 'provider-manifest/v1';
  manifestVersion: number;
  checkedAt: string;
  provider: {
    id: string;
    displayName: string;
    templateId: string;
    kind: string;
    source: 'official' | 'community' | 'custom';
    description: string;
    defaultModelId: string;
    defaultApiFamilyId: string;
    defaultCredentialId: string;
    defaultRegion?: string;
    notes?: string;
  };
  documentation: ProviderManifestDocumentation[];
  credentials: ProviderManifestCredential[];
  authProfiles: ProviderManifestAuthProfile[];
  transports: ProviderManifestTransport[];
  audioProfiles: ProviderManifestAudioProfile[];
  lifecycleProfiles: ProviderManifestLifecycleProfile[];
  apiFamilies: ProviderManifestApiFamily[];
  protocolProfiles: ProviderManifestProtocolProfile[];
  models: ProviderManifestModel[];
  probes: Array<{
    id: string;
    protocolProfileId: string;
    protocolProfileVersion: number;
    verification: ProviderManifestVerification;
    fixtureId?: string;
    notes?: string;
  }>;
  smokes: Array<{
    id: string;
    protocolProfileId: string;
    protocolProfileVersion: number;
    verification: ProviderManifestVerification;
    fixtureId?: string;
    notes?: string;
  }>;
  fixtures: Array<{
    id: string;
    path: string;
    kind: 'wire' | 'probe' | 'smoke' | 'error';
    sourceDocumentationIds: string[];
  }>;
};

export type AuthorizedProviderProtocol = {
  manifestVersion: number;
  providerId: string;
  profileOwnerProviderId: string;
  modelId: string;
  deploymentId: string | null;
  operation: ProviderManifestOperation;
  protocolProfile: ProviderManifestProtocolProfile;
  apiFamily: ProviderManifestApiFamily;
  transport: ProviderManifestTransport;
  authProfile: ProviderManifestAuthProfile;
  audioProfile: ProviderManifestAudioProfile | null;
  lifecycleProfile: ProviderManifestLifecycleProfile;
};
