import type { AudioRuntimeSnapshot } from '../schema/audio-runtime';

export type AecCapability = {
  backend: AudioRuntimeSnapshot['aecBackend'];
  status: AudioRuntimeSnapshot['aecStatus'];
  failureDetail: string | null;
  ready: boolean;
};

/** Normalized renderer view of the Rust-owned WebRTC AEC3 build gate. */
export function resolveAecCapability(snapshot: AudioRuntimeSnapshot): AecCapability {
  return {
    backend: snapshot.aecBackend,
    status: snapshot.aecStatus,
    failureDetail: snapshot.aecFailureDetail?.trim() || null,
    ready: snapshot.aecBackend === 'webrtc-aec3' && snapshot.aecStatus === 'ready',
  };
}
