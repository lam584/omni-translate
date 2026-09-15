export type ConfigStatus = 'draft' | 'ready' | 'warning' | 'unsupported' | 'unknown';

import type { AudioRouteContract } from './audio-contract';
import type {
  BridgeRuntimeState,
  DriverBridgeErrorCode,
  DriverBridgeProtocolVersion,
  DriverHealthState,
  DriverRepairAction,
} from './driver-bridge-contract';
import type { ProviderAuthRef, ProviderCapability, ProviderInteractionCapability, ProviderKind, ProviderTransport } from './provider-contract';
import type { ProviderProbeSnapshot } from './provider-probe';
import type { ProviderTemplateSource } from './provider-template';
import type { GlossaryInjectionSource, GlossaryInjectionStrategy, GlossaryProcessingMode, GlossaryScenario } from './glossary-template';
import type { GlossaryLibrary } from './glossary-package';
import type { ScenarioMode } from './scenario';
import type { TtsDispatchState, TtsOutputTarget } from './tts-contract';

export type ProviderMode = 'template' | 'advanced';

export type AudioRouteMode = ScenarioMode;

export type ProviderScenario = 'watch' | 'game' | 'voice-room' | 'subtitle-translate';

export type SubtitleTranslationMode = 'native' | 'secondary';

export type VirtualMicState = 'not-installed' | 'pending' | 'ready';

export type FeedbackLoopPrevention = 'none' | 'echo-cancel' | 'virtual-driver' | 'process-exclusion';

export type SubtitleMode = 'bilingual' | 'translation-only';

export type CaptionDensity = 'compact' | 'balanced' | 'detailed';

export type SubtitlePriority = 'subtitle-first' | 'balanced';
export type TranslationAudioSource = 'auto' | 'omni-native' | 'subtitle-tts';
export type SubtitleOverlayTextAlign = 'left' | 'center' | 'right';
export type SubtitleOverlayFontWeight = 400 | 500 | 600 | 700;

export type SubtitleOverlayTextStyle = {
  color: string;
  fontWeight: SubtitleOverlayFontWeight;
  outlineEnabled: boolean;
  outlineColor: string;
  outlineWidth: number;
  shadowEnabled: boolean;
  shadowColor: string;
  shadowOpacity: number;
  shadowOffsetX: number;
  shadowOffsetY: number;
  shadowBlur: number;
};

export type GlossaryImportStrategy = 'replace' | 'merge';

export type DiagnosticsSupportTier = 'stable' | 'experimental';

export type DiagnosticsExportScope = 'summary' | 'quick' | 'full';

export type DriverInstallChannel = 'development' | 'release';

export type DriverInstallPhase =
  | 'idle'
  | 'planned'
  | 'probing'
  | 'elevation-required'
  | 'waiting-for-elevation'
  | 'waiting-for-restart'
  | 'installing-driver'
  | 'uninstalling-driver'
  | 'starting-bridge'
  | 'verifying'
  | 'rollback-required'
  | 'ready';

export type ProviderModelCatalogCacheItem = {
  id: string;
  displayName: string;
  ownedBy: string | null;
  createdAt: number | null;
  capabilities: ProviderCapability[];
  providerTemplateId: string;
  providerTemplateName: string;
};

export type ProviderModelCatalogCache = {
  signature: string;
  source: 'runtime' | 'preset';
  endpoint: string | null;
  fetchedAt: string | null;
  error: string | null;
  models: ProviderModelCatalogCacheItem[];
};

export type ProviderModelProtocolOperation =
  | 'native_translate'
  | 'dialogue'
  | 'asr'
  | 'tts'
  | 'file_translate'
  | 'voice_clone';

export type ProviderModelProtocolTransport = 'websocket' | 'webrtc' | 'aoq' | 'http' | 'sse';

export type ProviderModelWireDialect =
  | 'bailian-livetranslate-session-ws-v1'
  | 'bailian-omni-realtime-ws-v1'
  | 'bailian-qwen-audio-chat-realtime-ws-v1'
  | 'bailian-qwen-asr-session-ws-v1'
  | 'bailian-qwen-audio-asr-task-ws-v1'
  | 'bailian-fun-asr-task-ws-v1'
  | 'bailian-paraformer-task-ws-v1'
  | 'bailian-gummy-task-ws-v1'
  | 'bailian-speech-synthesizer-duplex-task-ws-v1'
  | 'bailian-sambert-one-shot-task-ws-v1'
  | 'bailian-qwen-tts-session-ws-v1'
  | 'bailian-multimodal-dialog-task-ws-v1';

export type ProviderModelProtocolFraming =
  | 'json-base64'
  | 'json-events'
  | 'binary'
  | 'json-events-and-binary'
  | 'http-body'
  | 'sse'
  | 'none';

export type ProviderModelProtocolTerminalLifecycle =
  | 'session.finish->session.finished'
  | 'owner-close-after-response-drain'
  | 'finish-task->task-finished'
  | 'task-finished-after-one-shot'
  | 'Stop->Stopped'
  | 'http-response-complete'
  | 'sse-[DONE]';

export type ProviderModelProtocolProfileDeclaration = {
  registryVersion: string;
  profileId: string;
  profileVersion: number;
  product: string;
  operations: ProviderModelProtocolOperation[];
  transport: ProviderModelProtocolTransport;
  endpointFamily: string;
  endpointPath: string;
  wireDialect: ProviderModelWireDialect;
  inputFraming: ProviderModelProtocolFraming;
  outputFraming: ProviderModelProtocolFraming;
  terminalLifecycle: ProviderModelProtocolTerminalLifecycle;
  adapterStatus: 'enabled' | 'manifest-only';
};

export type ProviderModelCapabilityRegistryEntry = {
  id: string;
  modelId: string;
  capabilities: ProviderCapability[];
  /**
   * Versioned Bailian protocol-profile declaration copied from the official
   * manifest. Local capability rows remain advisory; these fields are only
   * identity assertions checked by the manifest authorizer before connection.
   */
  registryVersion?: string;
  profileId?: string;
  profileVersion?: number;
  /**
   * Read-only manifest projection for UI and persisted diagnostics. It cannot
   * grant a connection: runtime authority is still rehydrated from the exact
   * registry/profile/version identity and validated before transport access.
   */
  modelProtocolProfile?: ProviderModelProtocolProfileDeclaration;
  /** @deprecated Legacy UI metadata; never protocol authority for DashScope. */
  realtimeProtocol?: RealtimeProtocol;
  realtimeAudioMode?: RealtimeAudioMode;
  interactionCapabilities?: ProviderInteractionCapability[];
  apiModes?: string[];
  releasedAt?: string;
  source?: 'official' | 'runtime' | 'preset' | 'inferred' | 'manual';
  notes?: string;
};

export type RealtimeAudioMode = 'manual' | 'server_vad' | 'semantic_vad' | 'gemini_auto_activity' | 'gemini_manual_activity';

/**
 * Legacy route projection for existing UI/runtime contracts. Bailian task,
 * TTS, and dialogue products are identified by versioned manifest profiles;
 * they must not be added here as a substitute for an executable pipeline.
 */
export type RealtimeProtocol =
  | 'dashscope-omni'
  | 'dashscope-livetranslate'
  | 'dashscope-asr'
  | 'openai-conversation'
  | 'openai-translation'
  | 'openai-transcription'
  | 'openai-flat'
  | 'gemini-live';

export type ProviderCustomHeaderDraft = {
  id: string;
  name: string;
  value: string;
  enabled: boolean;
};

export type ProviderSceneModelAssignment = {
  scenario: ProviderScenario;
  modelIds: string[];
};

export type ProviderModelProtocolBinding = {
  modelId: string;
  operation: string;
  profileOwnerProviderId: string;
  manifestVersion: number;
  profileId: string;
  profileVersion: number;
  authProfileId?: string;
};

export type ProviderResponseModality = 'text' | 'audio';

export type ProviderDraft = {
  templateId: string;
  templateVersion: string;
  templateSource: ProviderTemplateSource;
  providerId: string;
  /** Canonical module owner; derived from the immutable template identity. */
  manifestProviderId?: string;
  kind: ProviderKind;
  /** @deprecated Legacy template hint; never protocol authority for DashScope. */
  templateRealtimeProtocol?: RealtimeProtocol;
  /** @deprecated Legacy provider hint; never protocol authority for DashScope. */
  realtimeProtocol?: RealtimeProtocol;
  displayName: string;
  mode: ProviderMode;
  model: string;
  /** Azure-style opaque deployment alias, separate from the catalog model. */
  deploymentId?: string;
  baseUrl: string;
  transport: ProviderTransport;
  authRef: ProviderAuthRef;
  region?: string;
  streamEnabled: boolean;
  timeoutMs: number;
  systemPromptTemplate: string;
  temperature: number;
  maxOutputTokens: number;
  responseModalities: ProviderResponseModality[];
  customHeaders: ProviderCustomHeaderDraft[];
  sceneModelAssignments: ProviderSceneModelAssignment[];
  modelProtocolBindings?: ProviderModelProtocolBinding[];
  localModelCapabilityRegistry: ProviderModelCapabilityRegistryEntry[];
  modelCatalogCache: ProviderModelCatalogCache;
  probe: ProviderProbeSnapshot;
  status: ConfigStatus;
};

export type DeviceDraft = {
  routeMode: AudioRouteMode;
  inputDeviceId: string;
  outputDeviceId: string;
  virtualRenderDeviceId: string;
  playbackDeviceId: string;
  virtualMicState: VirtualMicState;
  inboundRoute: AudioRouteContract;
  outboundRoute: AudioRouteContract;
  supportProfileId: string;
  inboundVoiceModelId: string;
  outboundVoiceModelId: string;
  textToSpeechModelId: string;
  subtitleTranslationMode: SubtitleTranslationMode;
  subtitleTranslationModelId: string;
  inboundSecondaryAudioModelId: string;
  // Audio processing
  inputLevel: number;
  aecEnabled: boolean;
  ansEnabled: boolean;
  agcEnabled: boolean;
  // Output controls
  outputLevel: number;
  outputSpeechEnabled: boolean;
  outputSubtitlesEnabled: boolean;
  virtualMicOutputEnabled: boolean;
  feedbackLoopPrevention: FeedbackLoopPrevention;
  status: ConfigStatus;
};

export type SubtitleDraft = {
  sourceLanguage: string;
  targetLanguage: string;
  /** Conversation-mode microphone translation target; empty = derive from sourceLanguage (auto falls back to en). */
  outboundTargetLanguage: string;
  translationLanguagePreference: string;
  mode: SubtitleMode;
  captionDensity: CaptionDensity;
  priority: SubtitlePriority;
  instructions: string;
  overlayOpacity: number;
  overlayLocked: boolean;
  /** Legacy shared color kept for importing older configuration documents. */
  overlayTextColor: string;
  overlayTextOpacity: number;
  overlayTextAlign: SubtitleOverlayTextAlign;
  overlaySourceTextStyle: SubtitleOverlayTextStyle;
  overlayTranslationTextStyle: SubtitleOverlayTextStyle;
  overlayBackgroundColor: string;
  overlayBackgroundOpacity: number;
  overlayFontFamily: string;
  overlayFontSize: number;
  overlayWidth: number;
  overlayHeight: number;
  overlayX: number;
  overlayY: number;
  history: SubtitleHistoryDraft;
  status: ConfigStatus;
};

export type SubtitleHistoryDraft = {
  enabled: boolean;
  sourceAudioEnabled: boolean;
  translatedAudioEnabled: boolean;
};

export type SpeechDraft = {
  enabled: boolean;
  targetLanguage: string;
  voicePresetId: string;
  textToSpeechModelId: string;
  voice: string;
  outputTarget: TtsOutputTarget;
  localPlaybackEnabled: boolean;
  virtualMicOutputEnabled: boolean;
  translationAudioSource: TranslationAudioSource;
  dispatchState: TtsDispatchState;
  status: ConfigStatus;
};

// These fields overlap with RuntimeSnapshot.bridge. They remain in the draft
// contract for UI compatibility, while relational storage mirrors them into
// runtime_state_cache instead of driver_preferences.
export type DriverDraft = {
  protocolVersion: DriverBridgeProtocolVersion;
  installChannel: DriverInstallChannel;
  installPhase: DriverInstallPhase;
  targetDeviceId: string;
  expectedDriverVersion: string;
  expectedBridgeVersion: string;
  bridgeState: BridgeRuntimeState;
  driverHealth: DriverHealthState;
  rollbackSupported: boolean;
  lastErrorCode?: DriverBridgeErrorCode;
  recommendedAction?: DriverRepairAction;
  status: ConfigStatus;
};

export type GlossaryDraft = {
  templateId: string;
  scenario: GlossaryScenario;
  injectionStrategy: GlossaryInjectionStrategy;
  injectionOrder: GlossaryInjectionSource[];
  /** @deprecated — 迁移到 libraries[] */
  activePackageIds: string[];
  /** @deprecated — 迁移到 libraries[] */
  communityPackageIds: string[];
  /** @deprecated — 迁移到 libraries[] */
  gameDictionaryId?: string;
  importStrategy: GlossaryImportStrategy;
  exportFormat: 'json';
  // New fields
  processingMode: GlossaryProcessingMode;
  calibrationModelId: string;
  libraries: GlossaryLibrary[];
  status: ConfigStatus;
};

// These fields overlap with RuntimeSnapshot.diagnostics. They remain in the
// draft contract for UI compatibility, while live statuses are runtime data.
export type DiagnosticsDraft = {
  installStatus: ConfigStatus;
  driverStatus: ConfigStatus;
  providerStatus: ConfigStatus;
  deviceStatus: ConfigStatus;
  lastExportScope: DiagnosticsExportScope;
  supportTier: DiagnosticsSupportTier;
  status: ConfigStatus;
};

export type OnboardingDraft = {
  activePresetId: string;
  completedStepIds: string[];
  unresolvedRiskIds: string[];
  checklistStatus: ConfigStatus;
};

export type AppConfigDraft = {
  activeProviderTemplateId: string;
  providers: ProviderDraft[];
  devices: DeviceDraft;
  subtitles: SubtitleDraft;
  speech: SpeechDraft;
  driver: DriverDraft;
  glossary: GlossaryDraft;
  diagnostics: DiagnosticsDraft;
  onboarding: OnboardingDraft;
  lastActivePagePath?: string;
};
export type SQLiteFieldMapping = {
  draftPath: string;
  sqliteTable: string;
  sqliteColumn: string;
  note: string;
};

export const appConfigFieldMappings: SQLiteFieldMapping[] = [
  { draftPath: 'providers[0].templateId', sqliteTable: 'providers', sqliteColumn: 'template_id', note: 'Provider template identity.' },
  { draftPath: 'providers[0].providerId', sqliteTable: 'providers', sqliteColumn: 'provider_id', note: 'Provider contract identity.' },
  { draftPath: 'providers[0].model', sqliteTable: 'providers', sqliteColumn: 'model', note: 'Active default model.' },
  { draftPath: 'providers[0].baseUrl', sqliteTable: 'providers', sqliteColumn: 'base_url', note: 'Provider endpoint.' },
  { draftPath: 'providers[0].transport', sqliteTable: 'providers', sqliteColumn: 'transport', note: 'Provider transport.' },
  { draftPath: 'providers[0].probe.verdict', sqliteTable: 'providers', sqliteColumn: 'probe_verdict', note: 'Latest provider probe verdict.' },
  { draftPath: 'providers[0].authRef.reference', sqliteTable: 'provider_auth_refs', sqliteColumn: 'reference', note: 'Credential reference only; secret stays outside SQLite.' },
  { draftPath: 'providers[0].customHeaders[]', sqliteTable: 'provider_custom_headers', sqliteColumn: 'header_id', note: 'Child table ordered by position.' },
  { draftPath: 'providers[0].responseModalities[]', sqliteTable: 'provider_response_modalities', sqliteColumn: 'modality', note: 'Child table ordered by position.' },
  { draftPath: 'providers[0].sceneModelAssignments[].modelIds[]', sqliteTable: 'provider_scene_model_ids', sqliteColumn: 'model_id', note: 'Scenario model child rows.' },
  { draftPath: 'providers[0].localModelCapabilityRegistry[].capabilities[]', sqliteTable: 'provider_model_capabilities', sqliteColumn: 'capability', note: 'Model capability child rows.' },
  { draftPath: 'providers[0].modelCatalogCache.models[]', sqliteTable: 'provider_model_catalog_items', sqliteColumn: 'item_id', note: 'Cached model catalog rows.' },
  { draftPath: 'devices.routeMode', sqliteTable: 'audio_device_preferences', sqliteColumn: 'route_mode', note: 'Current route mode.' },
  { draftPath: 'devices.inputDeviceId', sqliteTable: 'audio_device_preferences', sqliteColumn: 'input_device_id', note: 'Default input device.' },
  { draftPath: 'devices.outputDeviceId', sqliteTable: 'audio_device_preferences', sqliteColumn: 'output_device_id', note: 'Translated output device.' },
  { draftPath: 'devices.virtualRenderDeviceId', sqliteTable: 'audio_device_preferences', sqliteColumn: 'virtual_render_device_id', note: 'Virtual speaker endpoint used as the pre-mix source.' },
  { draftPath: 'devices.playbackDeviceId', sqliteTable: 'audio_device_preferences', sqliteColumn: 'playback_device_id', note: 'Playback device.' },
  { draftPath: 'devices.virtualMicState', sqliteTable: 'audio_device_preferences', sqliteColumn: 'virtual_mic_state', note: 'Virtual mic readiness.' },
  { draftPath: 'devices.inboundVoiceModelId', sqliteTable: 'audio_device_preferences', sqliteColumn: 'inbound_voice_model_id', note: 'Voice model for system-output to user translation.' },
  { draftPath: 'devices.outboundVoiceModelId', sqliteTable: 'audio_device_preferences', sqliteColumn: 'outbound_voice_model_id', note: 'Voice model for microphone to peer translation.' },
  { draftPath: 'devices.textToSpeechModelId', sqliteTable: 'audio_device_preferences', sqliteColumn: 'text_to_speech_model_id', note: 'Text-to-speech model for translated speech output.' },
  { draftPath: 'devices.subtitleTranslationMode', sqliteTable: 'audio_device_preferences', sqliteColumn: 'subtitle_translation_mode', note: 'Subtitle translation mode.' },
  { draftPath: 'devices.subtitleTranslationModelId', sqliteTable: 'audio_device_preferences', sqliteColumn: 'subtitle_translation_model_id', note: 'Secondary subtitle model.' },
  { draftPath: 'devices.inputLevel', sqliteTable: 'audio_device_preferences', sqliteColumn: 'input_level', note: 'Input gain level (0-100).' },
  { draftPath: 'devices.aecEnabled', sqliteTable: 'audio_device_preferences', sqliteColumn: 'aec_enabled', note: 'Legacy/manual processing toggle outside echo-cancel; the echo-cancel route always forces its WebRTC AEC3 backend on.' },
  { draftPath: 'devices.ansEnabled', sqliteTable: 'audio_device_preferences', sqliteColumn: 'ans_enabled', note: 'Automatic noise suppression.' },
  { draftPath: 'devices.agcEnabled', sqliteTable: 'audio_device_preferences', sqliteColumn: 'agc_enabled', note: 'Automatic gain control.' },
  { draftPath: 'devices.outputLevel', sqliteTable: 'audio_device_preferences', sqliteColumn: 'output_level', note: 'Output volume level (0-100).' },
  { draftPath: 'devices.outputSpeechEnabled', sqliteTable: 'audio_device_preferences', sqliteColumn: 'output_speech_enabled', note: 'Output translated speech toggle.' },
  { draftPath: 'devices.outputSubtitlesEnabled', sqliteTable: 'audio_device_preferences', sqliteColumn: 'output_subtitles_enabled', note: 'Output translated subtitles toggle.' },
  { draftPath: 'devices.virtualMicOutputEnabled', sqliteTable: 'audio_device_preferences', sqliteColumn: 'virtual_mic_output_enabled', note: 'Virtual microphone output toggle.' },
  { draftPath: 'devices.feedbackLoopPrevention', sqliteTable: 'audio_device_preferences', sqliteColumn: 'feedback_loop_prevention', note: 'Feedback loop prevention strategy.' },
  { draftPath: 'devices.inboundRoute.input.deviceId', sqliteTable: 'audio_routes', sqliteColumn: 'input_device_id', note: 'Inbound route input device.' },
  { draftPath: 'devices.outboundRoute.input.deviceId', sqliteTable: 'audio_routes', sqliteColumn: 'input_device_id', note: 'Outbound route input device.' },
  { draftPath: 'devices.outboundRoute.pushToTalk.hotkey', sqliteTable: 'audio_routes', sqliteColumn: 'push_to_talk_hotkey', note: 'Outbound push-to-talk hotkey.' },
  { draftPath: 'devices.inboundRoute.outputs[]', sqliteTable: 'audio_route_outputs', sqliteColumn: 'target_id', note: 'Route output child rows.' },
  { draftPath: 'subtitles.targetLanguage', sqliteTable: 'subtitle_preferences', sqliteColumn: 'target_language', note: 'Subtitle target language.' },
  { draftPath: 'subtitles.outboundTargetLanguage', sqliteTable: 'config_documents', sqliteColumn: 'config_json', note: 'Outbound (microphone) translation target language; document fallback keeps older SQLite schemas compatible.' },
  { draftPath: 'subtitles.translationLanguagePreference', sqliteTable: 'subtitle_preferences', sqliteColumn: 'translation_language_preference', note: 'Preferred translation language.' },
  { draftPath: 'subtitles.priority', sqliteTable: 'subtitle_preferences', sqliteColumn: 'priority_mode', note: 'Subtitle priority mode.' },
  { draftPath: 'subtitles.overlayOpacity', sqliteTable: 'subtitle_preferences', sqliteColumn: 'overlay_opacity', note: 'Overlay opacity.' },
  { draftPath: 'subtitles.overlayLocked', sqliteTable: 'subtitle_preferences', sqliteColumn: 'overlay_locked', note: 'Overlay lock state.' },
  { draftPath: 'subtitles.overlayTextAlign', sqliteTable: 'config_documents', sqliteColumn: 'config_json', note: 'Overlay text alignment.' },
  { draftPath: 'subtitles.overlaySourceTextStyle', sqliteTable: 'config_documents', sqliteColumn: 'config_json', note: 'Source subtitle typography and effects.' },
  { draftPath: 'subtitles.overlayTranslationTextStyle', sqliteTable: 'config_documents', sqliteColumn: 'config_json', note: 'Translated subtitle typography and effects.' },
  { draftPath: 'subtitles.sourceLanguage', sqliteTable: 'subtitle_preferences', sqliteColumn: 'source_language', note: 'Subtitle source language.' },
  { draftPath: 'subtitles.mode', sqliteTable: 'subtitle_preferences', sqliteColumn: 'display_mode', note: 'Subtitle display mode.' },
  { draftPath: 'subtitles.captionDensity', sqliteTable: 'subtitle_preferences', sqliteColumn: 'caption_density', note: 'Caption density.' },
  { draftPath: 'subtitles.history.enabled', sqliteTable: 'config_documents', sqliteColumn: 'config_json', note: 'Encrypted subtitle history enabled by default.' },
  { draftPath: 'subtitles.history.sourceAudioEnabled', sqliteTable: 'config_documents', sqliteColumn: 'config_json', note: 'Encrypted source audio archive toggle.' },
  { draftPath: 'subtitles.history.translatedAudioEnabled', sqliteTable: 'config_documents', sqliteColumn: 'config_json', note: 'Encrypted translated audio archive toggle.' },
  { draftPath: 'speech.enabled', sqliteTable: 'speech_preferences', sqliteColumn: 'speech_enabled', note: 'TTS feature toggle.' },
  { draftPath: 'speech.targetLanguage', sqliteTable: 'speech_preferences', sqliteColumn: 'target_language', note: 'TTS target language.' },
  { draftPath: 'speech.textToSpeechModelId', sqliteTable: 'speech_preferences', sqliteColumn: 'text_to_speech_model_id', note: 'Text-to-speech model for speech dispatch.' },
  { draftPath: 'speech.outputTarget', sqliteTable: 'speech_preferences', sqliteColumn: 'output_target', note: 'TTS output target.' },
  { draftPath: 'speech.translationAudioSource', sqliteTable: 'config_documents', sqliteColumn: 'config_json', note: 'Translated audio source policy; document fallback keeps older SQLite schemas compatible.' },
  { draftPath: 'driver.targetDeviceId', sqliteTable: 'driver_preferences', sqliteColumn: 'target_device_id', note: 'Configured virtual driver target.' },
  { draftPath: 'driver.driverHealth', sqliteTable: 'runtime_state_cache', sqliteColumn: 'driver.driverHealth', note: 'Runtime cache entry.' },
  { draftPath: 'driver.bridgeState', sqliteTable: 'runtime_state_cache', sqliteColumn: 'driver.bridgeState', note: 'Runtime cache entry.' },
  { draftPath: 'glossary.templateId', sqliteTable: 'glossary_preferences', sqliteColumn: 'template_id', note: 'Active glossary template.' },
  { draftPath: 'glossary.activePackageIds[]', sqliteTable: 'glossary_active_packages', sqliteColumn: 'package_id', note: 'Active package child rows.' },
  { draftPath: 'glossary.communityPackageIds[]', sqliteTable: 'glossary_community_packages', sqliteColumn: 'package_id', note: 'Community package child rows.' },
  { draftPath: 'glossary.injectionOrder[]', sqliteTable: 'glossary_injection_order', sqliteColumn: 'source', note: 'Injection order child rows.' },
  { draftPath: 'diagnostics.supportTier', sqliteTable: 'diagnostic_preferences', sqliteColumn: 'support_tier', note: 'Diagnostics preference.' },
  { draftPath: 'diagnostics.providerStatus', sqliteTable: 'runtime_state_cache', sqliteColumn: 'diagnostics.providerStatus', note: 'Runtime cache entry.' },
  { draftPath: 'diagnostics.deviceStatus', sqliteTable: 'runtime_state_cache', sqliteColumn: 'diagnostics.deviceStatus', note: 'Runtime cache entry.' },
  { draftPath: 'onboarding.activePresetId', sqliteTable: 'onboarding_state', sqliteColumn: 'active_preset_id', note: 'Active onboarding preset.' },
  { draftPath: 'onboarding.completedStepIds[]', sqliteTable: 'onboarding_completed_steps', sqliteColumn: 'step_id', note: 'Completed onboarding steps ordered by position.' },
  { draftPath: 'onboarding.unresolvedRiskIds[]', sqliteTable: 'onboarding_unresolved_risks', sqliteColumn: 'risk_id', note: 'Unresolved onboarding risks ordered by position.' },
  { draftPath: 'lastActivePagePath', sqliteTable: 'config_documents', sqliteColumn: 'config_json', note: 'Document fallback for fields that do not need dedicated query columns.' },
];
