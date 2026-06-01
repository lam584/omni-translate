export type ObsTransport = 'websocket' | 'named-pipe';

export type ObsOutputChannel = 'subtitle-overlay' | 'translation-status' | 'scene-trigger';

export type ObsCaptionCommitMode = 'final-only' | 'partial-and-final';

export type ObsAuthRef = {
  kind: 'credential-ref' | 'env-ref' | 'none';
  reference: string;
};

export type ObsOutputBinding = {
  channel: ObsOutputChannel;
  sceneName: string;
  sourceName: string;
  textField?: string;
  enabled: boolean;
};

export type ObsFailurePolicy = {
  degradeToDesktopOverlay: boolean;
  retryOnDisconnect: boolean;
  retryBackoffMs: number;
};

export type ObsIntegrationContract = {
  connectionId: string;
  protocolVersion: '2026-05-10';
  transport: ObsTransport;
  endpoint: string;
  auth: ObsAuthRef;
  captionCommitMode: ObsCaptionCommitMode;
  outputs: ObsOutputBinding[];
  emitTranslationStatus: boolean;
  failurePolicy: ObsFailurePolicy;
};