import type { ProviderModelProtocolBinding, RealtimeProtocol } from './config';
import type { ProviderAuthScheme, ProviderCapability, ProviderKind, ProviderTransport } from './provider-contract';

export type ProviderTemplateSource = 'official' | 'community' | 'custom';

export type ModelPreset = {
  id: string;
  model: string;
  displayName: string;
  capabilities: ProviderCapability[];
  description: string;
};

export type ProviderTemplateFieldTier = 'required' | 'recommended' | 'advanced';

export type ProviderTemplateFieldKey =
  | 'model'
  | 'deploymentId'
  | 'baseUrl'
  | 'authRef.reference'
  | 'authRef.headerName'
  | 'transport'
  | 'timeoutMs'
  | 'region'
  | 'systemPromptTemplate'
  | 'streamEnabled';

export type ProviderTemplateField = {
  id: string;
  key: ProviderTemplateFieldKey;
  label: string;
  description: string;
};

export type ProviderTemplateFieldGroup = {
  id: string;
  label: string;
  description: string;
  tier: ProviderTemplateFieldTier;
  fields: ProviderTemplateField[];
};

export type ProviderTemplateDraftDefaults = {
  providerId: string;
  manifestProviderId?: string;
  kind: ProviderKind;
  displayName: string;
  model: string;
  deploymentId?: string;
  baseUrl: string;
  transport: ProviderTransport;
  auth: {
    headerName: string;
    reference: string;
    scheme: ProviderAuthScheme;
  };
  region?: string;
  streamEnabled: boolean;
  timeoutMs: number;
  systemPromptTemplate: string;
  modelProtocolBindings?: ProviderModelProtocolBinding[];
};

export type ProviderTemplateMapping = {
  templateFieldKey: ProviderTemplateFieldKey;
  contractFieldPath: string;
  note: string;
};

export type ProviderTemplate = {
  id: string;
  manifestProviderId?: string;
  source: ProviderTemplateSource;
  version: string;
  displayName: string;
  description: string;
  protocolLabel: string;
  realtimeProtocol?: RealtimeProtocol;
  notes: string;
  supportedTransports: ProviderTransport[];
  defaultDraft: ProviderTemplateDraftDefaults;
  fieldGroups: ProviderTemplateFieldGroup[];
  contractMappings: ProviderTemplateMapping[];
  presetModels: ModelPreset[];
};
